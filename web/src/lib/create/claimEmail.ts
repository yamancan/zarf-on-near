// The one email "Email All Recipients" sends (T-039). Single source: the mailer Worker (mailer/src/template.ts)
// imports this file, and /create shows its text as the preview, so what the sender sees is what is sent.
// No imports: it must build in both the Worker and the web app. Every value passed in is verified by the mailer
// first (sender and deadline from the contract, email and amount from a matching Merkle leaf, link on its fixed origin).

export const formatAmount = (v: bigint, decimals = 6): string => {
  const s = v.toString().padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return s.slice(0, -decimals) + (frac ? `.${frac}` : '');
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface Mail {
  subject: string;
  text: string;
  html: string;
}

/** A 64-hex implicit account reads as noise in a subject: first 6 and last 4. */
const shortAccount = (a: string) => (/^[0-9a-f]{64}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function claimEmail(v: { sender: string; email: string; amount: string; deadlineNs: string; link: string; testnet: boolean; origin: string }): Mail {
  const amount = `${formatAmount(BigInt(v.amount))} ${v.testnet ? 'Test USDC' : 'USDC'}`;
  const until = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  }).format(Number(BigInt(v.deadlineNs) / 1_000_000n));
  const host = v.origin.replace(/^https?:\/\//, '');
  const sender = shortAccount(v.sender);
  const lead = `${sender} sent you ${amount} with Zarf.${v.testnet ? ' Test USDC is practice money with no value.' : ''}`;
  const how = `Zarf sends USDC to an email address. To claim it, open your link and sign in with Google as ${v.email}. Then choose the NEAR account (your wallet) it goes to; the page helps if you have none.`;
  const check = `Before you sign in, check that the page address starts with ${v.origin}/.`;
  const keep = `Claim it before ${until}. Keep this link to yourself: it is your claim.`;
  const ignore = 'Not expecting this? Ignore this email; nothing happens.';
  const why = `Sent by Zarf (Trion Labs) because ${sender} listed this address. Zarf never asks for a password, a seed phrase or a payment. Privacy: ${v.origin}/privacy`;
  return {
    subject: `${sender} sent you ${amount} on Zarf`,
    text: [lead, '', how, '', v.link, '', check, keep, ignore, '', why].join('\n'),
    html: [
      `<p>${esc(lead)}</p>`,
      `<p>${esc(how)}</p>`,
      `<p><a href="${esc(v.link)}">Claim ${esc(amount)} on ${esc(host)}</a></p>`,
      `<p>${esc(check)}<br>${esc(keep)}<br>${esc(ignore)}</p>`,
      `<p style="color:#777;font-size:13px">${esc(why)}</p>`,
    ].join('\n'),
  };
}
