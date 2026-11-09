import { claimPayload, isValidAccountId, unhex } from '../../verifier/src/claim';
import { base58Decode, signTx, type NearKey } from './near';
import { RpcError, viewAccessKey, viewFunction, type Rpc } from './rpc';

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
  if (typeof destination !== 'string' || !isValidAccountId(destination)) return refuse(400, 'BAD_DESTINATION');
  if (!isU64(campaign_id) || !isU64(expires_at_ns) || !isHex32(commitment) || !isHex32(signer)) return refuse(400, 'E108_INVALID_INPUT');
  if (typeof signature !== 'string' || !/^[0-9a-f]{128}$/.test(signature)) return refuse(400, 'E108_INVALID_INPUT');
  if (!Array.isArray(proof) || proof.length > 20 || !proof.every(isHex32)) return refuse(400, 'E108_INVALID_INPUT');
  if (typeof amount !== 'string' || !U128.test(amount) || BigInt(amount) >> 128n) return refuse(400, 'E109_INVALID_AMOUNT');

  if (!(await d.perCommitment.limit({ key: `${campaign_id}/${commitment}` })).success) return refuse(429, 'RATE_LIMITED');

  // Every tx costs the relayer gas, so relay only what our verifier signed and the contract will accept in time.
  const nowNs = BigInt(Math.floor(d.nowMs ?? Date.now())) * 1_000_000n;
  if (BigInt(expires_at_ns) < nowNs) return refuse(409, 'E114_CLAIM_EXPIRED');
  if (BigInt(expires_at_ns) > nowNs + MAX_EXPIRY_NS) return refuse(400, 'E108_INVALID_INPUT');
  if (!d.verifierSigners.includes(signer)) return refuse(403, 'E101_INVALID_SIGNATURE');
  const payload = claimPayload({ network: d.network, contract_id: d.contractId, campaign_id, commitment, amount, destination, expires_at_ns });
  const signerKey = await crypto.subtle.importKey('raw', unhex(signer, 32), 'Ed25519', false, ['verify']);
  if (!(await crypto.subtle.verify('Ed25519', signerKey, unhex(signature, 64), payload))) return refuse(403, 'E101_INVALID_SIGNATURE');

  const args = new TextEncoder().encode(JSON.stringify({ campaign_id, commitment, amount, proof, destination, expires_at_ns, signer, signature }));
  try {
    return await submit(args, d, true);
  } catch (e) {
    if (e instanceof RelayerMisconfigured) return refuse(500, 'RELAYER_MISCONFIGURED');
    if (e instanceof RpcError) return refuse(503, 'UPSTREAM_UNAVAILABLE');
    throw e;
  }
}

class RelayerMisconfigured extends Error {}

interface TxOutcome {
  status?: { SuccessValue?: string; Failure?: unknown };
}

async function submit(args: Uint8Array, d: RelayDeps, retryNonce: boolean): Promise<RelayResult> {
  const [gas, ak] = await Promise.all([
    viewFunction<string>(d.rpc, d.contractId, 'required_claim_gas', {}),
    viewAccessKey(d.rpc, d.relayerAccountId, d.key.publicKeyStr),
  ]);
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
    if (retryNonce && detail.includes('InvalidNonce')) return submit(args, d, false); // another isolate took this nonce
    if (detail.includes('TIMEOUT_ERROR')) return { status: 200, body: { tx_hash: hash } }; // sent; the app follows the hash
    throw e;
  }
  if (outcome.status?.Failure) {
    const code = /E1\d\d_[A-Z_]+/.exec(JSON.stringify(outcome.status.Failure))?.[0] ?? 'CLAIM_TX_FAILED';
    return { status: 409, body: { error: code, tx_hash: hash } };
  }
  return { status: 200, body: { tx_hash: hash } };
}
