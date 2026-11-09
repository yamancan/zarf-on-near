// Salts, commitments, tree, leaf list and claim links for one campaign.

import { hex } from '../claim';
import { treeRoot } from '../merkle';
import type { LeafList } from '../services';
import { canonicalEmail, type Row } from './recipients';

export interface Recipient {
  email: string;
  amount: string; // u128, decimal (base units)
  salt: string; // hex32: only in the claim link and the sender's recovery file
  commitment: string; // hex32
}

export interface Draft {
  recipients: Recipient[];
  merkleRoot: string;
  total: string;
}

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

export async function commitment(saltHex: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', unhex(saltHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalEmail(email))));
}

export const newSalt = (): string => hex(crypto.getRandomValues(new Uint8Array(32)));

/** One fresh salt per row (never reused); `salts` is for tests only. */
export async function buildDraft(rows: Row[], salts: () => string = newSalt): Promise<Draft> {
  const recipients: Recipient[] = [];
  for (const r of rows) {
    const salt = salts();
    recipients.push({ email: r.email, amount: r.amount.toString(), salt, commitment: await commitment(salt, r.email) });
  }
  return {
    recipients,
    merkleRoot: await treeRoot(recipients.map(({ commitment, amount }) => ({ commitment, amount }))),
    total: recipients.reduce((t, r) => t + BigInt(r.amount), 0n).toString(),
  };
}

/** The public file the claim app reads (spec "Leaf list"): no emails, no salts. */
export const leafList = (campaignId: string, d: Draft): LeafList => ({
  campaign_id: campaignId,
  merkle_root: d.merkleRoot,
  leaves: d.recipients.map(({ commitment, amount }) => ({ commitment, amount })),
});

export const claimLink = (claimOrigin: string, campaignId: string, r: Recipient): string =>
  `${claimOrigin}/claim/${campaignId}/${r.commitment}#s=${r.salt}`;

/** Everything needed to rebuild the links if the page is lost. It holds the salts: keep it private. */
export const recoveryFile = (d: Draft, deadlineNs: string) =>
  JSON.stringify({ kind: 'zarf-near-recovery-v1', merkle_root: d.merkleRoot, deadline_ns: deadlineNs, recipients: d.recipients }, null, 2);
