// The one email the mailer sends. Every value in it is verified first: the sender and deadline come from the
// contract, the amount and email from a leaf whose Merkle proof matched the campaign root, and the link is built
// here on the fixed CLAIM_ORIGIN. Nothing typed by the caller reaches the text.

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

export function claimEmail(v: { sender: string; email: string; amount: string; deadlineNs: string; link: string; testnet: boolean; home: string }): Mail {
  const unit = v.testnet ? 'Test USDC' : 'USDC';
  const amount = `${formatAmount(BigInt(v.amount))} ${unit}`;
  const until = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short',
  }).format(Number(BigInt(v.deadlineNs) / 1_000_000n));
  const lines = [
    `${v.sender} sent you ${amount} with Zarf.`,
    `Open the link and sign in with Google as ${v.email}. You choose the ${v.testnet ? 'NEAR ' : ''}account it goes to.`,
    '',
    v.link,
    '',
    `Claim it before ${until}. Keep this link to yourself: it is your claim.`,
    ...(v.testnet ? ['Test USDC is practice money with no value.'] : []),
    `What is Zarf? ${v.home}`,
    'Not expecting this? Ignore this email; nothing happens.',
  ];
  const html = [
    `<p>${esc(v.sender)} sent you <strong>${esc(amount)}</strong> with Zarf.</p>`,
    `<p>Open the link and sign in with Google as ${esc(v.email)}. You choose the ${v.testnet ? 'NEAR ' : ''}account it goes to.</p>`,
    `<p><a href="${esc(v.link)}">Claim ${esc(amount)}</a></p>`,
    `<p>Claim it before ${esc(until)}. Keep this link to yourself: it is your claim.</p>`,
    ...(v.testnet ? ['<p>Test USDC is practice money with no value.</p>'] : []),
    `<p>What is Zarf? <a href="${esc(v.home)}">${esc(v.home)}</a></p>`,
    '<p>Not expecting this? Ignore this email; nothing happens.</p>',
  ].join('\n');
  return { subject: `${amount} for you, from ${v.sender}`, text: lines.join('\n'), html };
}
