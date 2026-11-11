// The judge's "try it with your Gmail" page (T10). Static, same origin as POST /faucet, no third-party anything.

// Turnstile loads its script and its challenge iframe from challenges.cloudflare.com; nothing else is third-party.
const TS = 'https://challenges.cloudflare.com';
const CSP = `default-src 'none'; script-src 'self' ${TS}; frame-src ${TS}; style-src 'unsafe-inline'; connect-src 'self' ${TS}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
const HEADERS = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

const html = (siteKey: string, claimHost: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Try Zarf on NEAR</title>
<style>
  :root { --bg: #fafaf9; --fg: #1c1917; --muted: #57534e; --line: #d6d3d1; --accent: #1d4ed8; --err: #b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --fg: #f5f5f4; --muted: #a8a29e; --line: #44403c; --accent: #93c5fd; --err: #fca5a5; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 17px/1.5 system-ui, sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 3rem 1rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; }
  .muted { color: var(--muted); font-size: .95rem; }
  label { display: block; margin-top: 1.5rem; font-weight: 600; }
  input { width: 100%; font: inherit; padding: .7rem .8rem; border: 1px solid var(--line); border-radius: 6px; background: transparent; color: inherit; }
  button, a.button { display: inline-block; margin-top: 1rem; font: inherit; font-weight: 600; padding: .7rem 1.2rem; border: 0; border-radius: 6px; background: var(--fg); color: var(--bg); cursor: pointer; text-decoration: none; }
  button:disabled { opacity: .5; cursor: wait; }
  button.secondary { margin-left: .5rem; background: transparent; color: var(--fg); border: 1px solid var(--line); }
  :focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
  #out { margin-top: 1.5rem; }
  .cf-turnstile { margin-top: 1rem; min-height: 65px; }
  a { color: var(--accent); }
  footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); }
  .error { color: var(--err); }
  code { word-break: break-all; font-size: .85rem; }
</style>
</head>
<body>
<main>
  <h1>Pay any email: try it</h1>
  <p>Type your Gmail address. We create a NEAR <strong>testnet</strong> campaign that holds test USDC for it, and give you the claim link.
     Open it, sign in with that Google account, and the USDC goes to the NEAR account you choose.</p>
  <p>Type the address exactly as your Google account shows it.</p>
  <p>To receive it you need a NEAR testnet account.
     <a href="https://docs.near.org/getting-started/create-account" rel="noopener">Create a free one</a> before you open the link.</p>
  <p class="muted">Testnet only, no real money. The email never goes on chain: the chain stores a salted hash.
     Our verifier service does see your email when you claim. One link per email per day.</p>
  <form id="f" novalidate>
    <label for="email">Your Gmail address</label>
    <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required spellcheck="false" autocapitalize="off" placeholder="you@gmail.com">
    <div class="cf-turnstile" data-sitekey="${siteKey}" data-response-field="false"></div>
    <button id="go" type="submit">Create my claim link</button>
  </form>
  <div id="out" role="status" aria-live="polite"></div>
  <footer class="muted">
    <a href="${claimHost}/">About Zarf on NEAR</a> · <a href="${claimHost}/privacy">Privacy and terms</a>
  </footer>
</main>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<script src="/try.js"></script>
</body>
</html>`;

const JS = `(() => {
  const EMPTY = 'The faucet is empty for today. Try again tomorrow, or contact the team (see Privacy and terms below).';
  const MESSAGES = {
    BAD_EMAIL: 'That does not look like an email address. Use plain ASCII, exactly as Google shows it.',
    RATE_LIMITED_EMAIL: 'This email already got a link today. Use the link you have, or try again tomorrow.',
    RATE_LIMITED_IP: 'Too many links from this network today. Try again tomorrow.',
    DAILY_CAP_REACHED: 'The faucet has given out today\\'s test USDC. Try again tomorrow.',
    TURNSTILE_FAILED: 'The human check did not pass. Complete it and try again.',
    TURNSTILE_UNAVAILABLE: 'The human check is unavailable right now. Try again in a minute.',
    FAUCET_NOT_PREPAID: 'The faucet is out of storage funds right now. Please try again later.',
    FAUCET_EMPTY: EMPTY,
  };
  const f = document.getElementById('f'), go = document.getElementById('go'), out = document.getElementById('out');
  const show = (nodes) => out.replaceChildren(...nodes);
  const el = (tag, props, text) => Object.assign(document.createElement(tag), props, text ? { textContent: text } : {});
  const copyButton = (url) => {
    const btn = el('button', { type: 'button', className: 'secondary' }, 'Copy link');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed: long-press the button above';
      }
    });
    return btn;
  };
  // Say so before anyone types: an empty faucet cannot give out a link.
  fetch('/health').then((r) => r.json()).then((h) => {
    if (h && h.ok && h.links_left === '0') {
      go.disabled = true;
      show([el('p', { className: 'error' }, EMPTY)]);
    }
  }).catch(() => {});
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const turnstile = window.turnstile && window.turnstile.getResponse();
    if (!turnstile) {
      show([el('p', { className: 'error' }, 'Please complete the human check first.')]);
      return;
    }
    go.disabled = true;
    show([el('p', {}, 'Creating your campaign on NEAR testnet…')]);
    try {
      const res = await fetch('/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: f.email.value, turnstile }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        show([el('p', { className: 'error' }, MESSAGES[body.error] || 'Something went wrong. Please try again in a minute.')]);
        return;
      }
      const usdc = (Number(body.amount) / 1e6).toString();
      show([
        el('p', {}, usdc + ' test USDC is waiting for ' + f.email.value.trim() + '.'),
        el('a', { className: 'button', href: body.claim_url }, 'Open my claim link'),
        copyButton(body.claim_url),
        el('p', { className: 'muted' }, 'Sign in with this same Google account. The link works until ' + new Date(Number(BigInt(body.deadline_ns) / 1000000n)).toLocaleString() + '; keep it private.'),
        ...(body.stub ? [el('p', { className: 'error' }, 'Demo mode: this campaign was not created on chain.')] : []),
      ]);
    } catch {
      show([el('p', { className: 'error' }, 'Could not reach the faucet. Check your connection and try again.')]);
    } finally {
      if (window.turnstile) window.turnstile.reset(); // a token is single use
      go.disabled = false;
    }
  });
})();`;

const escapeAttr = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, ''); // site keys are [0-9A-Za-z_-]

// Only an https origin is linked; anything else drops the footer links to the page itself.
const safeOrigin = (u: string) => (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(u.replace(/\/+$/, '')) ? u.replace(/\/+$/, '') : '');

export const tryPage = (siteKey: string, claimHost = ''): Response => new Response(html(escapeAttr(siteKey), safeOrigin(claimHost)), { headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
export const tryScript = (): Response => new Response(JS, { headers: { ...HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' } });
