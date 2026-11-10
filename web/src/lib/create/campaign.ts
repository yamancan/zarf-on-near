// Salts, commitments, tree and claim links for one campaign. Each link carries its own leaf's amount
// and proof (spec "claim link"), so no leaf list is published; the recovery file keeps them all.

import { hex, linkFragment } from '../claim';
import { buildTree } from '../merkle';
import { canonicalEmail, formatAmount, type Row } from './recipients';

export interface Recipient {
  email: string;
  amount: string; // u128, decimal (base units)
  salt: string; // hex32: only in the claim link and the sender's recovery file
  commitment: string; // hex32
  proof: string[]; // hex32 siblings, leaf -> root
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
  const leaves: Omit<Recipient, 'proof'>[] = [];
  for (const r of rows) {
    const salt = salts();
    leaves.push({ email: r.email, amount: r.amount.toString(), salt, commitment: await commitment(salt, r.email) });
  }
  const { root, proofs } = await buildTree(leaves.map(({ commitment, amount }) => ({ commitment, amount })));
  return {
    recipients: leaves.map((l, i) => ({ ...l, proof: proofs[i] })),
    merkleRoot: root,
    total: leaves.reduce((t, r) => t + BigInt(r.amount), 0n).toString(),
  };
}

/** spec "claim link": `/claim/<id>/<commitment>#s=<salt>&a=<amount>&p=<base64url proof>`. */
export const claimLink = (claimOrigin: string, campaignId: string, r: Recipient): string =>
  `${claimOrigin}/claim/${campaignId}/${r.commitment}#${linkFragment(r)}`;

/** A proof grows each link by ~43 characters per tree level; some apps cut long links. */
export const LONG_LINKS_ABOVE = 500;

/** An email to one recipient with their link. The link is percent-encoded so `&` and `#` survive. */
export const mailtoHref = (r: Pick<Recipient, 'email' | 'amount'>, link: string): string =>
  `mailto:${encodeURIComponent(r.email)}?subject=${encodeURIComponent(`${formatAmount(BigInt(r.amount))} USDC for you`)}` +
  `&body=${encodeURIComponent(`You have ${formatAmount(BigInt(r.amount))} USDC to claim with your Google account:\n\n${link}\n\nKeep this link private: it is the only copy of your claim.`)}`;

/** Everything needed to rebuild the links if the page is lost. It holds the salts: keep it private. */
export const recoveryFile = (d: Draft, deadlineNs: string, ctx: { contractId: string; network: string; claimOrigin: string }) =>
  JSON.stringify(
    {
      kind: 'zarf-near-recovery-v1',
      contract_id: ctx.contractId,
      network: ctx.network,
      merkle_root: d.merkleRoot,
      deadline_ns: deadlineNs,
      how_to_recover:
        `On a ${ctx.network} explorer, find the campaign_created event logged by ${ctx.contractId} with merkle_root ` +
        `${d.merkleRoot}; its campaign_id completes each link: ${ctx.claimOrigin}/claim/<campaign_id>/<commitment>#s=<salt>&a=<amount>&p=<proof, base64url of the concatenated siblings>. ` +
        'If there is no such event, no campaign was created and the tokens stayed with you.',
      recipients: d.recipients,
    },
    null,
    2,
  );
