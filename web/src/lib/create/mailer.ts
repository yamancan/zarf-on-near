// "Email All Recipients" (T-039): asks the mailer Worker (mailer/) to email each recipient their claim link.
// One call per recipient; the mailer checks the leaf against the campaign on chain and builds the email itself.

import type { Recipient } from './campaign';

/** What a row shows after its call. 'claimed' and 'closed' are final; 'failed' offers a retry. */
export type MailStatus = 'sending' | 'sent' | 'claimed' | 'closed' | 'failed';

export async function notifyOne(mailerUrl: string, campaignId: string, r: Recipient, fetchFn: typeof fetch = (u, i) => fetch(u, i)): Promise<MailStatus> {
  try {
    const res = await fetchFn(`${mailerUrl}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaign_id: campaignId, email: r.email, salt: r.salt, amount: r.amount, proof: r.proof }),
    });
    if (res.ok) return 'sent'; // "sent" or "already_sent": either way the email went out once
    if (res.status === 409) return 'claimed';
    if (res.status === 410) return 'closed';
    return 'failed';
  } catch {
    return 'failed';
  }
}

/** Every row in `rows`, a few at a time (the mailer limits each IP to 120 a minute), reporting each as it settles. */
export async function emailAll(
  mailerUrl: string,
  campaignId: string,
  rows: Recipient[],
  onStatus: (commitment: string, s: MailStatus) => void,
  o: { concurrency?: number; fetchFn?: typeof fetch } = {},
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const r = rows[next++];
      onStatus(r.commitment, 'sending');
      onStatus(r.commitment, await notifyOne(mailerUrl, campaignId, r, o.fetchFn));
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, rows.length) }, worker));
}
