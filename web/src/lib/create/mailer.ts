// "Email All Recipients" (T-039): asks the mailer Worker (mailer/) to email each recipient their claim link.
// One call per recipient; the mailer checks the leaf against the campaign on chain and builds the email itself.

import type { Recipient } from './campaign';

/**
 * What a row shows after its call. 'claimed' and 'closed' are final; 'failed' offers a retry; 'waiting' = the mailer
 * has not confirmed an earlier send yet (it retries it itself after ten minutes); 'limit' = a daily or quota limit,
 * or the mailer is not set up: the batch stops and the manual path is the way on.
 */
export type MailStatus = 'sending' | 'sent' | 'claimed' | 'closed' | 'failed' | 'waiting' | 'limit';
const LIMITS = new Set(['MAIL_QUOTA', 'MAILER_MISCONFIGURED', 'DAILY_CAP', 'SENDER_DAILY_CAP', 'CAMPAIGN_CAP', 'SENDER_NOT_ALLOWED']);

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
    const error = String(((await res.json().catch(() => null)) as { error?: unknown } | null)?.error ?? '');
    if (error === 'IN_PROGRESS' || error === 'SEND_UNCONFIRMED') return 'waiting';
    if (LIMITS.has(error)) return 'limit';
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
  let stop = false; // a limit stops the batch: no point asking again until tomorrow
  const worker = async () => {
    while (next < rows.length && !stop) {
      const r = rows[next++];
      onStatus(r.commitment, 'sending');
      const st = await notifyOne(mailerUrl, campaignId, r, o.fetchFn);
      if (st === 'limit') stop = true;
      onStatus(r.commitment, st);
    }
  };
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, rows.length) }, worker));
}
