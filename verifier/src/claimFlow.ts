import type { ChainReader } from './chain';
import { commitment, hex, isValidAccountId, leafHash, signClaim, unhex, verifyMerkleProof, type Signer } from './claim';
import { TokenError, verifyGoogleIdToken } from './googleIdToken';
import { checkIntentsStatus, fetchIntentsStatus, IntentsError } from './intents';
import type { JwksSource } from './jwks';
import { UpstreamError } from './upstream';

export const SIGNATURE_TTL_NS = 600_000_000_000n; // spec: expires_at_ns = now + 10 min

export interface ClaimDeps {
  clientId: string;
  contractId: string;
  jwks: JwksSource;
  issuers?: string[];
  chain: ChainReader;
  signer: Signer;
  measurementId?: string; // Mode T only: this agent's approved measurement id
  intentsStatus?: (depositAddress: string) => Promise<unknown>; // 1Click GET /v0/status; tests stub it
  nowMs?: number;
}

export type ClaimResult = { status: number; body: Record<string, unknown> };

const U64 = /^(0|[1-9]\d{0,19})$/;
const U128 = /^[1-9]\d{0,38}$/; // amount 0 is E109
const HEX32 = /^[0-9a-f]{64}$/;
const refuse = (status: number, error: string): ClaimResult => ({ status, body: { error } });

/**
 * POST /claim: everything the contract will check that the verifier can check first, then sign.
 * Only these fields are read from the request; contract_id comes from config and network from
 * the chain, so a request naming another contract cannot turn the verifier into a signing oracle.
 */
export async function handleClaim(input: unknown, d: ClaimDeps): Promise<ClaimResult> {
  const b = (input ?? {}) as Record<string, unknown>;
  const { id_token, campaign_id, commitment: c, amount, proof, destination, salt } = b;
  if (typeof id_token !== 'string' || typeof destination !== 'string') return refuse(400, 'E108_INVALID_INPUT');
  // Destination first: the nonce is only ever computed over a valid AccountId.
  if (!isValidAccountId(destination)) return refuse(400, 'BAD_DESTINATION');
  if (typeof campaign_id !== 'string' || !U64.test(campaign_id) || BigInt(campaign_id) >> 64n) return refuse(400, 'E108_INVALID_INPUT');
  if (typeof c !== 'string' || !HEX32.test(c) || typeof salt !== 'string' || !HEX32.test(salt)) return refuse(400, 'E108_INVALID_INPUT');
  if (!Array.isArray(proof) || proof.length > 20 || !proof.every((p) => typeof p === 'string' && HEX32.test(p))) return refuse(400, 'E108_INVALID_INPUT');
  if (typeof amount !== 'string') return refuse(400, 'E108_INVALID_INPUT');
  if (!U128.test(amount) || BigInt(amount) >> 128n) return refuse(400, 'E109_INVALID_AMOUNT');
  // Cross-chain payout (T9b): `destination` is a 1Click deposit address; refunds go to the campaign sender.
  const intents = b.intents == null ? null : (b.intents as Record<string, unknown>);
  if (
    intents &&
    (typeof intents !== 'object' || typeof intents.destination_asset !== 'string' || typeof intents.recipient !== 'string' || !HEX32.test(destination))
  ) {
    return refuse(400, 'E108_INVALID_INPUT');
  }

  const nowMs = d.nowMs ?? Date.now();
  let email: string;
  try {
    ({ email } = await verifyGoogleIdToken(id_token, { clientId: d.clientId, destination, jwks: d.jwks, issuers: d.issuers, nowMs }));
  } catch (e) {
    if (e instanceof TokenError) return refuse(401, e.code);
    throw e;
  }

  // Contract check order (spec/claim.md), so the verifier never signs a claim the contract would refuse.
  const [network, campaign, state, agent] = await Promise.all([
    d.chain.getNetwork(), d.chain.getCampaign(campaign_id), d.chain.claimState(campaign_id, c), d.chain.getAgent(d.signer.signer),
  ]).catch(() => {
    throw new UpstreamError('chain');
  });
  if (!campaign) return refuse(404, 'E110_UNKNOWN_CAMPAIGN');
  if (intents && network !== 'mainnet') return refuse(400, 'E108_INVALID_INPUT'); // 1Click routes mainnet USDC only
  const nowNs = BigInt(Math.floor(nowMs)) * 1_000_000n;
  if (nowNs > BigInt(campaign.deadline_ns)) return refuse(409, 'E125_CAMPAIGN_ENDED');
  if (state === 'claimed') return refuse(409, 'E105_ALREADY_CLAIMED');
  if (state === 'pending') return refuse(409, 'E123_CLAIM_PENDING');
  // The salt proves which allocation this email opens; a wrong salt or another person's link fails here.
  if (hex(await commitment(unhex(salt, 32), email)) !== c) return refuse(403, 'COMMITMENT_MISMATCH');
  if (!(await verifyMerkleProof(await leafHash(c, amount), proof as string[], campaign.merkle_root))) {
    return refuse(403, 'E102_INVALID_MERKLE_PROOF');
  }
  // Our key must be one this campaign accepts: our signer (owner policy) or our measurement (attested).
  const allowedAs = campaign.policy === 'owner' ? d.signer.signer : d.measurementId;
  if (!allowedAs || !campaign.snapshot.includes(allowedAs)) return refuse(403, 'E101_INVALID_SIGNATURE');
  // Our own registry entry must outlive the signature (it is gone while a key is removed and re-added).
  const expiresNs = nowNs + SIGNATURE_TTL_NS;
  if (!agent || BigInt(agent.valid_until_ns) < expiresNs) return refuse(403, 'E101_INVALID_SIGNATURE');
  if (BigInt(campaign.balance) < BigInt(amount)) return refuse(409, 'E129_INSUFFICIENT_BALANCE');

  const expires_at_ns = expiresNs.toString();
  if (intents) {
    let status: unknown;
    try {
      status = await (d.intentsStatus ?? fetchIntentsStatus)(destination);
      checkIntentsStatus(status, {
        depositAddress: destination, amount, destinationAsset: intents.destination_asset as string, recipient: intents.recipient as string,
        campaignSender: campaign.sender, expiresAtNs: expires_at_ns,
      });
    } catch (e) {
      if (e instanceof IntentsError) return refuse(409, e.code);
      throw new UpstreamError('1click'); // nothing signed; the page can retry
    }
  }
  const signature = await signClaim(d.signer.key, {
    network, contract_id: d.contractId, campaign_id, commitment: c, amount, destination, expires_at_ns,
  });
  // These are exactly the contract's `claim` args; the relayer submits them as-is.
  return {
    status: 200,
    body: { campaign_id, commitment: c, amount, proof, destination, expires_at_ns, signer: d.signer.signer, signature },
  };
}
