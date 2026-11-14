// POST /notify: email one recipient their claim link. Only a leaf that is really in a live, funded campaign gets
// mail: the commitment is recomputed from (salt, email), its Merkle proof must reach the campaign root read from the
// contract, the campaign must be before its deadline and the claim unclaimed. One mail per commitment, at most CAP
// per campaign. Nothing logged here carries the email or the salt.

import { ADDR_SPEC, canonicalEmail, claimLink, commitment, rootFromProof } from './proof';
import { claimEmail, type Mail } from './template';

export const CAP = 100; // emails per campaign, matches the 100-recipient create cap
const H = /^[0-9a-f]{64}$/;

export interface CampaignView {
  sender: string;
  token: string;
  merkle_root: string;
  deadline_ns: string;
  balance: string; // what is still claimable (a started claim has already left it)
}
export interface Gate {
  /** gate.ts gateStep: 'ok' = send now, 'sent' = it went out, 'pending' = being sent, 'cap' = the campaign has CAP. */
  reserve(campaignId: string, commitmentHex: string): Promise<'ok' | 'sent' | 'pending' | 'cap'>;
  /** Resend accepted it. */
  sent(campaignId: string, commitmentHex: string): Promise<void>;
  /** Resend refused it: the slot is free again for a retry. */
  release(campaignId: string, commitmentHex: string): Promise<void>;
}
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface Deps {
  getCampaign(id: string): Promise<CampaignView | null>;
  tokenId: string; // the one token this mailer writes about (USDC); any other campaign is refused
  claimState(id: string, commitmentHex: string): Promise<string>;
  gate: Gate;
  /** true = Resend accepted, false = Resend refused; throws when the outcome is unknown (timeout, network). */
  send(to: string, mail: Mail, idempotencyKey: string): Promise<boolean>;
  perIp: RateLimiter;
  nowMs: number;
  claimOrigin: string; // fixed config, never from the request
  testnet: boolean;
}
export interface Out {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string): Out => ({ status, body: { error } });

/** The request, checked for shape only (one recipient). */
export function parseBody(b: unknown): { campaignId: string; email: string; salt: string; amount: string; proof: string[] } | null {
  if (!b || typeof b !== 'object') return null;
  const { campaign_id, email, salt, amount, proof } = b as Record<string, unknown>;
  // Canonical decimal only: "7", never "07", so one campaign has one gate and one cap.
  if (typeof campaign_id !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(campaign_id) || BigInt(campaign_id) >> 64n) return null;
  if (typeof email !== 'string' || email.length > 254) return null;
  let canon: string;
  try {
    canon = canonicalEmail(email);
  } catch {
    return null;
  }
  if (!ADDR_SPEC.test(canon)) return null;
  if (typeof salt !== 'string' || !H.test(salt)) return null;
  if (typeof amount !== 'string' || !/^[1-9]\d{0,38}$/.test(amount) || BigInt(amount) >> 128n) return null;
  if (!Array.isArray(proof) || proof.length > 20 || !proof.every((x) => typeof x === 'string' && H.test(x))) return null;
  return { campaignId: campaign_id, email: canon, salt, amount, proof: proof as string[] };
}

/** `readBody` runs only after the rate limit, so a flood is refused before any body is read. */
export async function handleNotify(readBody: () => Promise<unknown>, ip: string, d: Deps): Promise<Out> {
  if (!(await d.perIp.limit({ key: ip })).success) return fail(429, 'RATE_LIMITED');
  const r = parseBody(await readBody().catch(() => null));
  if (!r) return fail(400, 'BAD_REQUEST');
  const c = await d.getCampaign(r.campaignId);
  const cm = await commitment(r.salt, r.email);
  // One answer for "no such campaign" and "not in it": the caller learns nothing beyond what the chain shows.
  if (!c || !H.test(c.merkle_root) || (await rootFromProof(cm, r.amount, r.proof)) !== c.merkle_root) return fail(403, 'NOT_IN_CAMPAIGN');
  if (BigInt(d.nowMs) * 1_000_000n > BigInt(c.deadline_ns)) return fail(410, 'CAMPAIGN_CLOSED');
  // A leaf is only worth an email if the campaign can still pay it, in the token the email names.
  if (c.token !== d.tokenId || BigInt(r.amount) > BigInt(c.balance)) return fail(403, 'NOT_FUNDED');
  if ((await d.claimState(r.campaignId, cm)) !== 'unclaimed') return fail(409, 'ALREADY_CLAIMED');
  const g = await d.gate.reserve(r.campaignId, cm);
  if (g === 'sent') return { status: 200, body: { status: 'already_sent' } };
  if (g === 'pending') return fail(429, 'IN_PROGRESS'); // another call is sending it: try again later, never "sent"
  if (g === 'cap') return fail(429, 'CAMPAIGN_CAP');
  const link = claimLink(d.claimOrigin, r.campaignId, { commitment: cm, salt: r.salt, amount: r.amount, proof: r.proof });
  const mail = claimEmail({ sender: c.sender, email: r.email, amount: r.amount, deadlineNs: c.deadline_ns, link, testnet: d.testnet, origin: d.claimOrigin });
  let ok: boolean;
  try {
    ok = await d.send(r.email, mail, `zarf-${r.campaignId}-${cm}`);
  } catch {
    // Unknown outcome: the mark stays pending; a retry after PENDING_RETRY_MS reuses the Idempotency-Key.
    return fail(504, 'SEND_UNCONFIRMED');
  }
  if (!ok) {
    await d.gate.release(r.campaignId, cm);
    return fail(502, 'SEND_FAILED');
  }
  await d.gate.sent(r.campaignId, cm);
  return { status: 200, body: { status: 'sent' } };
}
