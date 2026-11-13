// The judges' "try it with your Google email" page. Static, same origin as POST /faucet, no third-party anything.
import { FAVICON_SVG, SAIRA_WOFF2_B64 } from './assets';

// Turnstile loads its script and its challenge iframe from challenges.cloudflare.com; nothing else is third-party.
// The font and the favicon come from this Worker only ('self').
const TS = 'https://challenges.cloudflare.com';
const CSP = `default-src 'none'; script-src 'self' ${TS}; frame-src ${TS}; style-src 'unsafe-inline'; font-src 'self'; img-src 'self'; connect-src 'self' ${TS}; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`;
const HEADERS = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store' };

// The Zarf product mark, path verbatim from the main repo's ZarfLogo.svelte. One colour, no tile; never redraw it.
const MARK = (px: number) => `<svg class="mark" width="${px}" height="${px}" viewBox="0 0 11 11" fill="currentColor" aria-hidden="true"><path d="M0.898438 10.3896C0.394295 10.3384 0.000100606 9.91217 8.74228e-08 9.39453L8.21296e-07 0.999999L0.00586021 0.898437C0.0535571 0.427762 0.427821 0.0537464 0.898438 0.00585854L1 -8.21296e-07L9.39453 -8.74228e-08L9.49707 0.0058593C9.96765 0.0538002 10.342 0.427778 10.3896 0.898437L10.3945 1L10.3945 9.39453C10.3944 9.94672 9.94675 10.3945 9.39453 10.3945L1 10.3945L0.898438 10.3896ZM9.39453 6.0293L7.3457 7.21191C7.19382 7.2996 7.02108 7.34562 6.8457 7.3457L3.40918 7.3457L3.40918 6.3457L6.8457 6.3457L9.39453 4.875L9.39453 1L1 0.999999L1 4.34766L3.0752 3.14844C3.227 3.06088 3.39995 3.01473 3.5752 3.01465L7.01172 3.01465L7.01172 4.01465L3.5752 4.01465L1 5.50195L1 9.39453L9.39453 9.39453L9.39453 6.0293Z"/></svg>`;

// Lucide icons (ISC), stroke style as in the Zen components.
const ICON = (inner: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
const MAIL = '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>';
const SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>';
const MOON = '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>';
const CHEVRON = '<path d="m6 9 6 6 6-6"/>';
const X_ICON = '<svg class="icon" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>';
// The screenshot gallery (preview worker): every screen of the flow, for a judge who wants to look first.
const GALLERY = 'https://zarf-near-claim-preview.sparkling-queen-5e77.workers.dev/gallery/';

/** Token base units (6 decimals) as a decimal string, e.g. "500000" -> "0.5"; null unless a positive integer. */
export const usdcText = (amount: string): string | null => {
  if (!/^[1-9]\d{0,38}$/.test(amount ?? '')) return null;
  const s = amount.padStart(7, '0');
  const frac = s.slice(-6).replace(/0+$/, '');
  return s.slice(0, -6) + (frac ? '.' + frac : '');
};

// Zen tokens, values from the main Zarf repo (packages/ui/lib/styles/themes, apps/claim ground). Dark first.
const CSS = `
  @font-face { font-family: 'Saira'; font-weight: 400 700; font-display: swap; src: url('/saira.woff2') format('woff2'); }
  :root {
    --font-sans: 'Saira', ui-sans-serif, system-ui, sans-serif;
    --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    --bg: #0a0a0b; --bg-elevated: #131315; --fg: oklch(90% 0.01 260);
    --btn-bg: oklch(82% 0.008 260); --btn-bg-hover: oklch(92% 0.012 260); --btn-ring: oklch(92% 0.006 260); --btn-text: oklch(25% 0.008 260);
    --btn2-border: oklch(35% 0.006 260); --btn2-border-hover: oklch(55% 0.008 260); --btn2-text: oklch(72% 0.008 260); --btn2-bg-hover: oklch(25% 0.005 260);
    --primary: oklch(90% 0.01 280);
    --success: oklch(80% 0.12 155); --success-muted: oklch(25% 0.04 155);
    --warning: oklch(85% 0.12 85); --error: oklch(85% 0.1 25);
    --shadow-elevated: 0 1px 2px 0 oklch(0% 0 0 / 0.15), 0 4px 8px -2px oklch(0% 0 0 / 0.2), 0 12px 28px -4px oklch(0% 0 0 / 0.35);
    color-scheme: dark;
  }
  :root[data-theme='light'] {
    --bg: #f8f8fa; --bg-elevated: #ffffff; --fg: #211e23;
    --btn-bg: oklch(28% 0.008 290); --btn-bg-hover: oklch(18% 0.012 290); --btn-ring: oklch(18% 0.006 290); --btn-text: oklch(95% 0.003 290);
    --btn2-border: oklch(75% 0.006 290); --btn2-border-hover: oklch(45% 0.008 290); --btn2-text: oklch(45% 0.008 290); --btn2-bg-hover: oklch(92% 0.005 290);
    --primary: oklch(15% 0.02 290);
    --success: oklch(35% 0.12 155); --success-muted: oklch(95% 0.03 155);
    --warning: oklch(35% 0.14 85); --error: oklch(40% 0.14 25);
    --shadow-elevated: 0 1px 2px 0 oklch(22% 0.01 290 / 0.02), 0 4px 8px -2px oklch(22% 0.01 290 / 0.03), 0 8px 20px -4px oklch(22% 0.01 290 / 0.06);
    color-scheme: light;
  }
  :root {
    --fg-muted: oklch(from var(--fg) l c h / 0.72); --fg-subtle: oklch(from var(--fg) l c h / 0.55);
    --border: oklch(from var(--fg) l c h / 0.12); --border-subtle: oklch(from var(--fg) l c h / 0.06);
    --control-border: oklch(from var(--fg) l c h / 0.45); /* 3:1 against the card (WCAG 1.4.11) */
  }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  html { background: var(--bg); }
  body { margin: 0; min-height: 100vh; display: flex; flex-direction: column; background: var(--bg); color: var(--fg);
    font: 400 16px/1.5 var(--font-sans); -webkit-font-smoothing: antialiased; }
  a { color: inherit; }
  /* Zarf's app texture, verbatim from zarf web/apps/claim (and create) src/app.css .ripple-bg: fingerprint-like rings
     from the lower right, fixed, no motion. Pure CSS (no image, no new origin). Header, main and footer sit above it. */
  .ripple-bg { position: fixed; inset: 0; pointer-events: none; z-index: 0; opacity: 0.5; --ripple-color: oklch(from var(--fg) l c h / 0.03);
    background: repeating-radial-gradient(circle at 90% 90%, transparent 0px, transparent 7px, var(--ripple-color) 8px, transparent 9px); }
  :root[data-theme='light'] .ripple-bg { --ripple-color: oklch(from var(--fg) l c h / 0.025); opacity: 0.6; }
  header, main, footer { position: relative; z-index: 1; }
  :focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .icon { width: 16px; height: 16px; flex-shrink: 0; }

  /* Navbar: the web app's (ZarfNavbar): lockup left; network label, X, divider, toggle right. The label stays on phones.
     Lockup per the brand kit: mark as tall as the "f", ink gap 0.4x the mark (measured on the render, not the box). */
  header { height: 64px; padding: 0 24px; display: flex; align-items: center; justify-content: space-between;
    background: var(--bg); border-bottom: 0.5px solid var(--border-subtle); }
  .right { display: flex; align-items: center; gap: 16px; }
  .lockup { display: inline-flex; align-items: center; gap: 3.5px; min-height: 44px; text-decoration: none; opacity: .8; transition: opacity .2s; }
  .lockup:hover { opacity: 1; }
  .lockup span { font-size: 16px; font-weight: 600; letter-spacing: -0.025em; }
  .net { font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .15em; color: var(--fg-muted); white-space: nowrap; }
  .x { display: none; align-items: center; justify-content: center; min-height: 44px; color: var(--fg-subtle); transition: color .2s; }
  .x:hover { color: var(--fg); }
  .divider { display: none; width: 1px; height: 16px; background: var(--border); }
  @media (min-width: 640px) { .x { display: inline-flex; } .divider { display: block; } }
  .toggle { width: 44px; height: 44px; border: 0; border-radius: 9999px; background: transparent; color: var(--fg-muted);
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer; transition: background .2s, color .2s; }
  .toggle:hover { color: var(--fg); background: oklch(from var(--fg) l c h / 0.05); }

  main { flex: 1; width: 100%; max-width: 544px; margin: 0 auto; padding: 32px 16px 48px; }
  @media (min-width: 640px) { main { padding-top: 64px; } }
  /* ZenCard elevated, as the claim card (LoginPrompt). */
  .card { background: var(--bg-elevated); border: 0.5px solid var(--border-subtle); border-radius: 16px; box-shadow: var(--shadow-elevated); padding: 32px 24px; }
  @media (min-width: 440px) { .card { padding: 32px; } }
  .medallion { width: 64px; height: 64px; margin: 0 auto 24px; border-radius: 9999px; display: flex; align-items: center; justify-content: center;
    background: oklch(from var(--fg) l c h / 0.08); color: var(--fg); }
  .medallion .icon { width: 32px; height: 32px; }
  .medallion.ok { background: var(--success-muted); color: var(--success); border: 0.5px solid oklch(from var(--success) l c h / 0.2); }
  h1, h2 { margin: 0; text-align: center; font-weight: 600; letter-spacing: -0.025em; }
  h1, h2 { font-size: 20px; line-height: 1.3; text-wrap: balance; }
  h2:focus { outline: none; }
  .lede { margin: 8px 0 0; text-align: center; font-size: 15px; color: var(--fg-muted); text-wrap: balance; }

  form { margin-top: 28px; }
  label { display: block; font-size: 14px; font-weight: 500; margin-bottom: 8px; }
  input { display: block; width: 100%; min-height: 48px; padding: 12px 16px; font: inherit; font-size: 16px; color: var(--fg);
    background: oklch(from var(--bg) l c h / 0.5); border: 1px solid var(--control-border); border-radius: 12px; transition: border-color .2s, box-shadow .2s; }
  input::placeholder { color: var(--fg-subtle); }
  input:focus { outline: none; }
  input:focus-visible { border-color: var(--fg); box-shadow: 0 0 0 1px var(--fg); }
  input[aria-invalid='true'] { border-color: var(--error); }
  /* Turnstile "flexible": full width (min 300 px), clipped to the input's 12 px radius. */
  .ts { margin-top: 16px; min-height: 65px; border-radius: 12px; overflow: hidden; }
  /* ZenButton primary / secondary: full pill, text-sm semibold. */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 48px; padding: 12px 24px;
    font: 600 14px/1.2 var(--font-sans); letter-spacing: 0.02em; border: 0; border-radius: 9999px; cursor: pointer; text-decoration: none; transition: background .2s, box-shadow .2s, color .2s; }
  .primary { background: var(--btn-bg); color: var(--btn-text); box-shadow: inset 0 0 0 1px var(--btn-ring); }
  .primary:hover { background: var(--btn-bg-hover); }
  .secondary { background: transparent; color: var(--btn2-text); box-shadow: inset 0 0 0 1px var(--btn2-border); }
  .secondary:hover { background: var(--btn2-bg-hover); color: var(--fg); box-shadow: inset 0 0 0 1px var(--btn2-border-hover); }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn[aria-busy='true'] { cursor: wait; }
  #go { width: 100%; margin-top: 16px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } * { transition: none !important; } }
  .hint { margin: 16px 0 0; font-size: 13px; color: var(--fg-muted); text-align: center; text-wrap: balance; }
  .hint a, .more a { text-decoration: underline; text-underline-offset: 2px; }
  .hint a:hover { color: var(--fg); }

  /* Status rows: an icon plus text, never colour alone. */
  #out:not(:empty) { margin-top: 16px; }
  .note { display: flex; align-items: flex-start; gap: 8px; margin: 0; font-size: 14px; font-weight: 500; }
  .note .icon { margin-top: 3px; }
  .note p { margin: 0; text-wrap: pretty; }
  .note.error { color: var(--error); }
  .note.wait { color: var(--warning); }
  h2 + .note { margin-top: 16px; }

  /* "How this works": the detail, one layer down; the claim card's disclosure (centred, chevron after the label). */
  details { margin-top: 24px; padding-top: 16px; border-top: 0.5px solid var(--border-subtle); font-size: 13px; color: var(--fg-muted); }
  summary { display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { color: var(--fg); }
  summary .icon { width: 14px; height: 14px; transition: transform .2s; }
  details[open] summary .icon { transform: rotate(180deg); }
  .more { margin: 8px 0 0; padding-left: 20px; line-height: 1.6; }
  .more li + li { margin-top: 8px; }

  /* Link issued. */
  .amount { margin-top: 24px; text-align: center; }
  /* The web app's Amount: small uppercase label, large light figure, the unit BESIDE it. */
  .amount .label { display: block; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .3em; color: var(--fg-muted); }
  .amount .figure { display: flex; align-items: baseline; justify-content: center; gap: 8px; margin-top: 4px; }
  .amount .value { font-size: 48px; line-height: 1; font-weight: 300; letter-spacing: -0.05em; font-variant-numeric: tabular-nums; }
  .amount .unit { font-size: 14px; font-weight: 500; text-transform: uppercase; letter-spacing: .1em; color: var(--primary); white-space: nowrap; }
  .amount .for { display: block; margin-top: 8px; font-size: 14px; color: var(--fg-muted); overflow-wrap: anywhere; }
  .link { margin: 24px 0 0; font: 13px/1.4 var(--font-mono); color: var(--fg-muted); text-align: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 16px; }
  .actions .btn { flex: 1 1 180px; }
  .next { margin: 16px 0 0; font-size: 14px; color: var(--fg-muted); text-align: center; text-wrap: balance; }

  /* Footer: the web app's (lockup / Send · Campaigns · Privacy / built-on line), centred column, a row from 768 px. */
  footer { border-top: 1px solid oklch(from var(--fg) l c h / 0.05); font-size: 12px; color: var(--fg-muted); }
  .foot { max-width: 1024px; margin: 0 auto; padding: 40px 24px; display: flex; flex-direction: column; align-items: center; justify-content: space-between; gap: 20px; }
  @media (min-width: 768px) { .foot { flex-direction: row; } }
  footer .lockup { gap: 2.5px; opacity: 1; }
  footer .lockup span { font-size: 12px; }
  footer nav { display: flex; gap: 24px; font-weight: 500; }
  footer nav a, .by a { display: inline-flex; align-items: center; min-height: 44px; text-decoration: none; transition: color .2s; }
  footer nav a:hover, .by a:hover, footer .lockup:hover { color: var(--fg); }
  .by { display: flex; align-items: center; gap: 6px; }
  .by .dot { color: oklch(from var(--fg) l c h / 0.2); }
`;

const html = (siteKey: string, claimHost: string, usdc: string | null) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Try Zarf on NEAR</title>
<meta name="description" content="Send tokens to an email. Get a claim link for ${usdc ? usdc + ' ' : ''}test USDC and claim it with Google into a NEAR testnet account.">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>${CSS}</style>
</head>
<body>
<div class="ripple-bg" aria-hidden="true"></div>
<header>
  <a class="lockup" href="${claimHost}/" aria-label="Zarf home">${MARK(12)}<span>Zarf</span></a>
  <div class="right">
    <span class="net">NEAR Testnet</span>
    <a class="x" href="https://x.com/zarfto" target="_blank" rel="noopener noreferrer" aria-label="Follow Zarf on X">${X_ICON}</a>
    <div class="divider" aria-hidden="true"></div>
    <button id="theme" class="toggle" type="button" aria-label="Switch to light theme" hidden>
    <span data-when="dark">${ICON(SUN)}</span><span data-when="light" hidden>${ICON(MOON)}</span>
    </button>
  </div>
</header>
<main>
  <div class="card">
    <div id="ask">
      <div class="medallion">${ICON(MAIL)}</div>
      <h1>Try Zarf</h1>
      <p class="lede">A test claim link for your Google email. Claiming is free: Zarf pays the NEAR gas.</p>
      ${usdc ? `<div class="amount"><span class="label">Claim Amount</span><span class="figure"><span class="value">${usdc}</span><span class="unit">test USDC</span></span></div>` : ''}
      <form id="f" novalidate>
        <label for="email">Your Google email</label>
        <input id="email" name="email" type="email" autocomplete="email" inputmode="email" required spellcheck="false" autocapitalize="off" placeholder="you@gmail.com">
        <div class="ts"><div class="cf-turnstile" data-sitekey="${siteKey}" data-size="flexible" data-response-field="false"></div></div>
        <button id="go" class="btn primary" type="submit">Get Claim Link</button>
      </form>
    </div>
    <div id="out" role="status" aria-live="polite"></div>
    <p class="hint">No NEAR account needed — create one with Face ID when you claim.</p>
    <p class="hint">Want to look first? <a href="${GALLERY}" target="_blank" rel="noopener noreferrer">See every screen</a>.</p>
    <details>
      <summary>How this works ${ICON(CHEVRON)}</summary>
      <ul class="more">
        <li>We create a NEAR testnet campaign that holds the test USDC for your email and show you its claim link here. Nothing is emailed: this is the link a sender would email you.</li>
        <li>Open the link, pick your NEAR testnet account, and sign in with that same Google account. The USDC goes to that account.</li>
        <li>Your email never goes on chain; the chain stores a salted hash. Our verifier, operated by Trion Labs, sees your email once, when you claim.</li>
        <li>Testnet only. One link per email per day: ask again with the same email and you get the same link back.</li>
      </ul>
    </details>
  </div>
</main>
<footer>
  <div class="foot">
    <a class="lockup" href="${claimHost}/" aria-label="Zarf home">${MARK(9)}<span>Zarf</span></a>
    ${claimHost ? `<nav aria-label="Footer"><a href="${claimHost}/create">Send</a><a href="${claimHost}/campaigns">Campaigns</a><a href="${claimHost}/privacy">Privacy</a></nav>` : ''}
    <div class="by"><span>© 2026</span><span class="dot" aria-hidden="true">·</span><span>Built on NEAR by</span><a href="https://trionlabs.dev" target="_blank" rel="noopener noreferrer">trionlabs.dev</a></div>
  </div>
</footer>
<script src="/try.js"></script>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
</body>
</html>`;

// Presentation only: the requests, the checks and the error codes are the server's. Every value from the
// network or the user reaches the page through textContent or an href, never as markup.
const JS = `(() => {
  const ICONS = {
    error: '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    wait: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    spin: '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    copied: '<path d="M20 6 9 17l-5-5"/>',
    arrow: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  };
  // Constant markup only (the ICONS table), never data.
  const icon = (name, extra) => {
    const t = document.createElement('template');
    t.innerHTML = '<svg class="icon' + (extra ? ' ' + extra : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICONS[name] + '</svg>';
    return t.content.firstChild;
  };

  // Theme: dark unless this browser chose light (the Zarf apps' key and default).
  const root = document.documentElement, toggle = document.getElementById('theme');
  const saved = () => { try { return localStorage.getItem('zarf_theme'); } catch { return null; } };
  const applyTheme = (t) => {
    root.setAttribute('data-theme', t);
    toggle.setAttribute('aria-label', t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
    toggle.querySelector('[data-when="dark"]').hidden = t !== 'dark';
    toggle.querySelector('[data-when="light"]').hidden = t === 'dark';
  };
  applyTheme(saved() === 'light' ? 'light' : 'dark');
  toggle.hidden = false;
  toggle.addEventListener('click', () => {
    const t = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('zarf_theme', t); } catch {}
    applyTheme(t);
  });
  // This script runs before api.js (document order), so the human check renders in the page's theme.
  const widget = document.querySelector('.cf-turnstile');
  if (widget) widget.setAttribute('data-theme', root.getAttribute('data-theme'));

  const EMPTY = 'The faucet is empty right now. Try again later.';
  const SLOW = 'NEAR testnet is slow right now. Try again in a minute.';
  // [tone, text]. "wait": a limit that lifts by itself. "error": something to fix or retry.
  const MESSAGES = {
    BAD_EMAIL: ['error', 'That does not look like an email address. Use plain ASCII, exactly as Google shows it.'],
    RATE_LIMITED_EMAIL: ['wait', 'This email already got a link today. Use the link you have, or try again tomorrow.'],
    RATE_LIMITED_IP: ['wait', 'Too many links from this network today. Try again tomorrow.'],
    RATE_LIMITED_BURST: ['wait', 'Too many tries from this network in a few seconds. Wait a moment, then try again.'],
    DAILY_CAP_REACHED: ['wait', 'Today\\'s test USDC is all given out. Try again tomorrow.'],
    TURNSTILE_FAILED: ['error', 'The human check did not pass. Complete it and try again.'],
    TURNSTILE_UNAVAILABLE: ['error', 'The human check is unavailable right now. Try again in a minute.'],
    FAUCET_NOT_PREPAID: ['wait', 'The faucet needs a top-up. Try again later.'],
    FAUCET_EMPTY: ['wait', EMPTY],
    UPSTREAM_UNAVAILABLE: ['error', SLOW],
    CREATE_FAILED: ['error', SLOW],
    FAUCET_MISCONFIGURED: ['error', 'The test faucet is down right now. Try again later.'],
  };
  const f = document.getElementById('f'), go = document.getElementById('go'), out = document.getElementById('out');
  const ask = document.getElementById('ask'), email = document.getElementById('email');
  const GO_LABEL = go.textContent;
  const show = (nodes) => out.replaceChildren(...nodes);
  const el = (tag, props, text) => Object.assign(document.createElement(tag), props, text ? { textContent: text } : {});
  const note = (tone, text) => {
    const row = el('div', { className: 'note ' + tone });
    row.setAttribute('role', 'alert');
    row.append(icon(tone), el('p', {}, text));
    return row;
  };
  const busy = (on) => {
    go.disabled = on;
    if (on) { go.setAttribute('aria-busy', 'true'); go.replaceChildren(icon('spin', 'spin'), el('span', {}, 'Creating your link…')); }
    else { go.removeAttribute('aria-busy'); go.textContent = GO_LABEL; }
  };
  // Display only, one line at 390 px: no scheme, a long link loses its middle; Open and Copy use the full link.
  const middle = (u) => { const s = u.replace(/^https:\\/\\//, ''); return s.length > 36 ? s.slice(0, 23) + '…' + s.slice(-12) : s; };
  const until = (ms) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(new Date(ms)) + ' UTC';
  const copyButton = (url) => {
    const btn = el('button', { type: 'button', className: 'btn secondary' });
    btn.append(icon('copy'), el('span', {}, 'Copy Link'));
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(url);
        btn.replaceChildren(icon('copied'), el('span', {}, 'Copied'));
      } catch {
        btn.replaceChildren(icon('error'), el('span', {}, 'Copy failed'));
        if (!btn.dataset.told) { btn.dataset.told = '1'; btn.parentNode.after(note('error', 'Long-press Open and Claim to copy the link.')); }
      }
    });
    return btn;
  };
  // Say so before anyone types: an empty faucet cannot give out a link.
  fetch('/health').then((r) => r.json()).then((h) => {
    if (h && h.ok && h.links_left === '0') {
      go.disabled = true;
      show([note('wait', EMPTY)]);
    }
  }).catch(() => {});
  f.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    email.removeAttribute('aria-invalid');
    const turnstile = window.turnstile && window.turnstile.getResponse();
    if (!turnstile) {
      show([note('error', 'Complete the human check first.')]);
      return;
    }
    busy(true);
    show([el('p', { className: 'sr-only' }, 'Creating your campaign on NEAR testnet…')]);
    try {
      // The recovery token from this browser's first answer for this email (red team #1): without it a repeat gets
      // no link back. Kept per typed email in localStorage; the server compares it with a hash.
      const rkey = 'zarf_faucet_recovery:' + f.email.value.trim().toLowerCase();
      let recovery = null;
      try { recovery = localStorage.getItem(rkey); } catch {}
      const res = await fetch('/faucet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: f.email.value, turnstile, recovery }) });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.recovery_token) { try { localStorage.setItem(rkey, body.recovery_token); } catch {} }
      if (!res.ok) {
        const [tone, text] = MESSAGES[body.error] || ['error', 'Something went wrong. Please try again in a minute.'];
        if (body.error === 'BAD_EMAIL') email.setAttribute('aria-invalid', 'true');
        show([note(tone, text)]);
        return;
      }
      const usdc = (Number(body.amount) / 1e6).toString();
      const who = f.email.value.trim();
      // Demo mode created nothing on chain: never the green "ready" for a link that cannot work.
      if (body.stub) {
        const title = el('h2', { tabIndex: -1 }, 'Demo only: no link was created');
        ask.hidden = true;
        show([title, note('wait', 'This faucet is in demo mode. Nothing was created on NEAR, so there is no link to claim.')]);
        title.focus();
        return;
      }
      // A link was made for this email today, in another browser (or this one's storage was cleared): not shown here.
      if (body.reshown && !body.claim_url) {
        const title = el('h2', { tabIndex: -1 }, 'Already Sent Today');
        ask.hidden = true;
        show([title, note('wait', 'This email got its link today in another browser. Open it there; a new one is possible tomorrow.')]);
        title.focus();
        return;
      }
      const medal = el('div', { className: 'medallion ok' });
      medal.append(icon('copied'));
      const title = el('h2', { tabIndex: -1 }, body.reshown ? 'Your link from earlier' : 'Your link is ready');
      const amount = el('div', { className: 'amount' });
      const figure = el('span', { className: 'figure' });
      figure.append(el('span', { className: 'value' }, usdc), el('span', { className: 'unit' }, 'test USDC'));
      amount.append(el('span', { className: 'label' }, 'Waiting for you'), figure, el('span', { className: 'for' }, 'for ' + who));
      // A new tab: this page keeps the link on screen while the claim page strips its secret part.
      const open = el('a', { className: 'btn primary', href: body.claim_url, target: '_blank', rel: 'noopener' });
      open.append(el('span', {}, 'Open and Claim'), icon('arrow'));
      const actions = el('div', { className: 'actions' });
      actions.append(open, copyButton(body.claim_url));
      // The form goes away: a second submit could only replace this link with a quota message.
      ask.hidden = true;
      show([
        medal, title, amount,
        el('p', { className: 'link', title: body.claim_url }, middle(body.claim_url)),
        actions,
        el('p', { className: 'next' }, 'Sign in with ' + who + ' when it asks. The link works until ' + until(Number(BigInt(body.deadline_ns) / 1000000n)) + '; keep it private.'),
      ]);
      title.focus();
    } catch {
      show([note('error', 'Could not reach the faucet. Check your connection and try again.')]);
    } finally {
      if (window.turnstile) window.turnstile.reset(); // a token is single use
      busy(false);
    }
  });
})();`;

const escapeAttr = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, ''); // site keys are [0-9A-Za-z_-]

// Only an https origin is linked; anything else drops the footer links to the page itself.
const safeOrigin = (u: string) => (/^https:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(u.replace(/\/+$/, '')) ? u.replace(/\/+$/, '') : '');

export const tryPage = (siteKey: string, claimHost = '', amount = ''): Response =>
  new Response(html(escapeAttr(siteKey), safeOrigin(claimHost), usdcText(amount)), { headers: { ...HEADERS, 'Content-Type': 'text/html; charset=utf-8' } });
export const tryScript = (): Response => new Response(JS, { headers: { ...HEADERS, 'Content-Type': 'text/javascript; charset=utf-8' } });

const FONT = Uint8Array.from(atob(SAIRA_WOFF2_B64), (c) => c.charCodeAt(0));
/** The page's own static files; null for any other path. */
export const pageAsset = (path: string): Response | null => {
  const cache = { 'Cache-Control': 'public, max-age=86400' };
  if (path === '/saira.woff2') return new Response(FONT, { headers: { ...HEADERS, ...cache, 'Content-Type': 'font/woff2' } });
  if (path === '/favicon.svg') return new Response(FAVICON_SVG, { headers: { ...HEADERS, ...cache, 'Content-Type': 'image/svg+xml' } });
  return null;
};
