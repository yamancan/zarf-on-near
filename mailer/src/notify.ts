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
  merkle_root: string;
  deadline_ns: string;
}
export interface Gate {
  /** 'ok' reserves this commitment's one email; 'already' = reserved before; 'cap' = the campaign has CAP. */
  reserve(campaignId: string, commitmentHex: string): Promise<'ok' | 'already' | 'cap'>;
  /** Frees a reservation whose email did not go out, so a retry can send it. */
  release(campaignId: string, commitmentHex: string): Promise<void>;
}
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
}
export interface Deps {
  getCampaign(id: string): Promise<CampaignView | null>;
  claimState(id: string, commitmentHex: string): Promise<string>;
  gate: Gate;
  send(to: string, mail: Mail, idempotencyKey: string): Promise<boolean>;
  perIp: RateLimiter;
  nowMs: number;
  claimOrigin: string; // fixed config, never from the request
  home: string;
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
  if (typeof campaign_id !== 'string' || !/^\d{1,20}$/.test(campaign_id) || BigInt(campaign_id) >> 64n) return null;
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

export async function handleNotify(raw: unknown, ip: string, d: Deps): Promise<Out> {
  if (!(await d.perIp.limit({ key: ip })).success) return fail(429, 'RATE_LIMITED');
  const r = parseBody(raw);
  if (!r) return fail(400, 'BAD_REQUEST');
  const c = await d.getCampaign(r.campaignId);
  const cm = await commitment(r.salt, r.email);
  // One answer for "no such campaign" and "not in it": the caller learns nothing beyond what the chain shows.
  if (!c || !H.test(c.merkle_root) || (await rootFromProof(cm, r.amount, r.proof)) !== c.merkle_root) return fail(403, 'NOT_IN_CAMPAIGN');
  if (BigInt(d.nowMs) * 1_000_000n > BigInt(c.deadline_ns)) return fail(410, 'CAMPAIGN_CLOSED');
  if ((await d.claimState(r.campaignId, cm)) !== 'unclaimed') return fail(409, 'ALREADY_CLAIMED');
  const g = await d.gate.reserve(r.campaignId, cm);
  if (g === 'already') return { status: 200, body: { status: 'already_sent' } };
  if (g === 'cap') return fail(429, 'CAMPAIGN_CAP');
  const link = claimLink(d.claimOrigin, r.campaignId, { commitment: cm, salt: r.salt, amount: r.amount, proof: r.proof });
  const mail = claimEmail({ sender: c.sender, email: r.email, amount: r.amount, deadlineNs: c.deadline_ns, link, testnet: d.testnet, home: d.home });
  let ok = false;
  try {
    ok = await d.send(r.email, mail, `zarf-${r.campaignId}-${cm}`);
  } catch {
    ok = false;
  }
  if (!ok) {
    await d.gate.release(r.campaignId, cm);
    return fail(502, 'SEND_FAILED');
  }
  return { status: 200, body: { status: 'sent' } };
}
