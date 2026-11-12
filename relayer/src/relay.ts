import { claimPayload, isUncreditedDestination, isValidAccountId, unhex } from '../../verifier/src/claim';
import { base58Decode, signTx, type NearKey } from './near';
import { RpcError, viewAccessKey, viewAccount, viewFunction, type Rpc } from './rpc';

/** The Cloudflare rate-limit binding's interface. */
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}

export interface RelayDeps {
  rpc: Rpc;
  network: string;
  contractId: string;
  relayerAccountId: string;
  key: NearKey;
  verifierSigners: string[]; // hex32: only claims signed by our verifier are relayed
  perIp: RateLimiter;
  perCommitment: RateLimiter;
  nowMs?: number;
}

export type RelayResult = { status: number; body: Record<string, unknown> };

const FIELDS = ['amount', 'campaign_id', 'commitment', 'destination', 'expires_at_ns', 'proof', 'signature', 'signer'];
const U64 = /^(0|[1-9]\d{0,19})$/;
const U128 = /^[1-9]\d{0,38}$/;
const HEX32 = /^[0-9a-f]{64}$/;
const MAX_EXPIRY_NS = 3_600_000_000_000n; // the contract refuses expires_at_ns beyond now + 1 h
const refuse = (status: number, error: string): RelayResult => ({ status, body: { error } });

let lastNonce = 0n; // per isolate: concurrent claims in one isolate never reuse a nonce

/** Test helper: forget the nonce this isolate last used. */
export const resetNonce = () => (lastNonce = 0n);

/** POST /claim: exactly the verifier's 200 body (the contract's claim args) → { tx_hash }. */
export async function handleRelay(input: unknown, ip: string, d: RelayDeps): Promise<RelayResult> {
  if (!(await d.perIp.limit({ key: ip })).success) return refuse(429, 'RATE_LIMITED');

  const b = input as Record<string, unknown>;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join() !== FIELDS.join()) return refuse(400, 'E108_INVALID_INPUT');
  const { campaign_id, commitment, amount, proof, destination, expires_at_ns, signer, signature } = b;
  const isU64 = (v: unknown): v is string => typeof v === 'string' && U64.test(v) && !(BigInt(v) >> 64n);
  const isHex32 = (v: unknown): v is string => typeof v === 'string' && HEX32.test(v);
  // Same refusal as the verifier, before the format check: a plain ft_transfer there credits nobody.
  if (typeof destination === 'string' && isUncreditedDestination(destination)) return refuse(400, 'DESTINATION_CREDITS_NOBODY');
  if (typeof destination !== 'string' || !isValidAccountId(destination)) return refuse(400, 'BAD_DESTINATION');
  // Paying the escrow itself would lock the USDC in it for good (second audit S1); a token is checked in submit().
  if (destination === d.contractId) return refuse(400, 'DESTINATION_IS_CONTRACT');
  if (!isU64(campaign_id) || !isU64(expires_at_ns) || !isHex32(commitment) || !isHex32(signer)) return refuse(400, 'E108_INVALID_INPUT');
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return refuse(400, 'E108_INVALID_INPUT');
  if (!Array.isArray(proof) || proof.length > 20 || !proof.every(isHex32)) return refuse(400, 'E108_INVALID_INPUT');
  if (typeof amount !== 'string' || !U128.test(amount) || BigInt(amount) >> 128n) return refuse(400, 'E109_INVALID_AMOUNT');

  // Every tx costs the relayer gas, so relay only what our verifier signed and the contract will accept in time.
  const nowNs = BigInt(Math.floor(d.nowMs ?? Date.now())) * 1_000_000n;
  if (BigInt(expires_at_ns) < nowNs) return refuse(409, 'E114_CLAIM_EXPIRED');
  if (BigInt(expires_at_ns) > nowNs + MAX_EXPIRY_NS) return refuse(400, 'E108_INVALID_INPUT');
  if (!d.verifierSigners.includes(signer)) return refuse(403, 'E101_INVALID_SIGNATURE');
  const payload = claimPayload({ network: d.network, contract_id: d.contractId, campaign_id, commitment, amount, destination, expires_at_ns });
  const signerKey = await crypto.subtle.importKey('raw', unhex(signer, 32), 'Ed25519', false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', signerKey, unhex(signature, 64), payload))) return refuse(403, 'E101_INVALID_SIGNATURE');
  // Only a claim our verifier signed spends this link's budget, so garbage signatures cannot block a recipient (red-team L3).
  if (!(await d.perCommitment.limit({ key: `${campaign_id}/${commitment}` })).success) return refuse(429, 'RATE_LIMITED');

  const args = new TextEncoder().encode(JSON.stringify({ campaign_id, commitment, amount, proof, destination, expires_at_ns, signer, signature }));
  try {
    return await submit(args, d, true, { destination, campaign_id, commitment });
  } catch (e) {
    // Logs are fixed tags only: never the request, the error text or the tx.
    if (e instanceof DestinationIsToken) return refuse(400, 'DESTINATION_IS_TOKEN');
    if (e instanceof AlreadyDecided) return refuse(409, e.code);
    if (e instanceof RelayerMisconfigured) {
      console.log('misconfigured');
      return refuse(500, 'RELAYER_MISCONFIGURED');
    }
    if (e instanceof RpcError) {
      console.log('rpc_unavailable');
      return refuse(503, 'UPSTREAM_UNAVAILABLE');
    }
    throw e;
  }
}

class RelayerMisconfigured extends Error {}
class DestinationIsToken extends Error {}
/** claim_state says this link is already paid or in flight: a replay would only burn the relayer's gas. */
class AlreadyDecided extends Error {
  constructor(readonly code: 'E105_ALREADY_CLAIMED' | 'E123_CLAIM_PENDING') {
    super(code);
  }
}

interface TxOutcome {
  status?: { SuccessValue?: string; Failure?: unknown };
  receipts_outcome?: { outcome?: { executor_id?: string; logs?: string[] } }[];
}

/**
 * The tx's own status is on_claim's `()`, a success whether the transfer paid or reverted, so the
 * contract's NEP-297 event for this commitment decides.
 */
type ClaimEvent = 'claim_started' | 'claim_paid' | 'claim_reverted';

/** This commitment's most decisive claim event from our contract: paid or reverted beat started, in any receipt order. */
export function claimEvent(o: TxOutcome, contractId: string, commitment: string): ClaimEvent | null {
  const seen = new Set<ClaimEvent>();
  for (const r of o.receipts_outcome ?? []) {
    if (r.outcome?.executor_id !== contractId) continue;
    for (const log of r.outcome.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue;
      try {
        const e = JSON.parse(log.slice('EVENT_JSON:'.length));
        if (e.standard === 'zarf-near' && ['claim_started', 'claim_paid', 'claim_reverted'].includes(e.event) && e.data?.[0]?.commitment === commitment) {
          seen.add(e.event);
        }
      } catch {
        // not our event
      }
    }
  }
  return seen.has('claim_paid') ? 'claim_paid' : seen.has('claim_reverted') ? 'claim_reverted' : seen.has('claim_started') ? 'claim_started' : null;
}

const submitted = (hash: string): RelayResult => ({ status: 202, body: { tx_hash: hash, status: 'submitted' } });

type ClaimRef = { destination: string; campaign_id: string; commitment: string };

async function submit(args: Uint8Array, d: RelayDeps, retryNonce: boolean, claim: ClaimRef): Promise<RelayResult> {
  const { destination } = claim;
  const [gas, ak, config, state] = await Promise.all([
    viewFunction<string>(d.rpc, d.contractId, 'required_claim_gas', {}),
    viewAccessKey(d.rpc, d.relayerAccountId, d.key.publicKeyStr),
    viewFunction<{ token_ids?: unknown }>(d.rpc, d.contractId, 'get_config', {}),
    viewFunction<string>(d.rpc, d.contractId, 'claim_state', { campaign_id: claim.campaign_id, commitment: claim.commitment }),
  ]);
  // A replay of a public, already-landed claim (red-team M2): refuse before signing or paying gas.
  if (state === 'claimed') throw new AlreadyDecided('E105_ALREADY_CLAIMED');
  if (state === 'pending') throw new AlreadyDecided('E123_CLAIM_PENDING');
  // A claim paid to a token contract is lost to the recipient (second audit S1).
  if (Array.isArray(config?.token_ids) && config.token_ids.includes(destination)) throw new DestinationIsToken();
  // Never sign with a key that can do more than call `claim` on our contract.
  const fc = ak.permission === 'FullAccess' ? null : ak.permission.FunctionCall;
  if (!fc || fc.receiver_id !== d.contractId || fc.method_names.length !== 1 || fc.method_names[0] !== 'claim') {
    throw new RelayerMisconfigured();
  }
  if (typeof gas !== 'string' || !U64.test(gas)) throw new RpcError('required_claim_gas is not a u64 string');

  const chainNonce = BigInt(ak.nonce);
  const nonce = (chainNonce > lastNonce ? chainNonce : lastNonce) + 1n;
  lastNonce = nonce;
  const { signed, hash } = await signTx(d.key.key, {
    signerId: d.relayerAccountId, publicKey: d.key.publicKey, nonce, receiverId: d.contractId,
    blockHash: base58Decode(ak.block_hash), methodName: 'claim', args, gas: BigInt(gas),
  });

  let outcome: TxOutcome;
  try {
    outcome = await d.rpc.call<TxOutcome>('send_tx', { signed_tx_base64: btoa(String.fromCharCode(...signed)), wait_until: 'EXECUTED_OPTIMISTIC' });
  } catch (e) {
    const detail = e instanceof RpcError ? JSON.stringify(e.detail) : '';
    if (retryNonce && detail.includes('InvalidNonce')) {
      // Another isolate used this nonce; the error says where the key is now.
      const ak = /"ak_nonce":\s*(\d+)/.exec(detail);
      if (ak && BigInt(ak[1]) > lastNonce) lastNonce = BigInt(ak[1]);
      console.log('nonce_retry');
      return submit(args, d, false, claim);
    }
    if (detail.includes('TIMEOUT_ERROR')) return submitted(hash); // sent; the app follows claim_state
    throw e;
  }
  const { commitment } = JSON.parse(new TextDecoder().decode(args)) as { commitment: string };
  const event = claimEvent(outcome, d.contractId, commitment);
  if (outcome.status?.Failure) {
    // claim_started was logged, so the claim went pending before a later receipt failed (a stranded
    // callback): the outcome is unknown, not refused.
    if (event === 'claim_started') return submitted(hash);
    const code = /E1\d\d_[A-Z_]+/.exec(JSON.stringify(outcome.status.Failure))?.[0] ?? 'CLAIM_TX_FAILED';
    return { status: 409, body: { error: code, tx_hash: hash } };
  }
  if (event === 'claim_paid') return { status: 200, body: { tx_hash: hash, status: 'paid' } };
  if (event === 'claim_reverted') return { status: 409, body: { error: 'E115_TOKEN_TRANSFER_FAILED', tx_hash: hash } };
  return submitted(hash);
}

/** GET /health: numbers only, for monitoring the relayer key and account. */
export async function handleHealth(d: Pick<RelayDeps, 'rpc' | 'relayerAccountId' | 'key' | 'perIp' | 'contractId'>, ip: string): Promise<RelayResult> {
  if (!(await d.perIp.limit({ key: ip })).success) return refuse(429, 'RATE_LIMITED');
  try {
    const [ak, account] = await Promise.all([viewAccessKey(d.rpc, d.relayerAccountId, d.key.publicKeyStr), viewAccount(d.rpc, d.relayerAccountId)]);
    const fc = ak.permission === 'FullAccess' ? null : ak.permission.FunctionCall;
    // allowance null = unlimited (still claim-only); balance in yoctoNEAR
    return { status: 200, body: { contract_id: d.contractId, allowance: fc ? fc.allowance : null, balance: account.amount, claim_only: !!fc && fc.receiver_id === d.contractId && fc.method_names.join() === 'claim' } };
  } catch (e) {
    if (!(e instanceof RpcError)) throw e;
    console.log('rpc_unavailable');
    return refuse(503, 'UPSTREAM_UNAVAILABLE');
  }
}
