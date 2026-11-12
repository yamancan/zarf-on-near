// Fingerprint of the live claim page: its HTML (CSP nonces removed) and every same-origin script it
// loads, followed through static and dynamic imports. No imports: scripts/fingerprint.ts runs this under Node.

export interface Fingerprint {
  page: string;
  html: string;
  /** pathname -> sha256 hex of the bytes served */
  scripts: Record<string, string>;
}

type Fetcher = (url: string) => Promise<Response>;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (data: ArrayBuffer | Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', data as BufferSource));

/** The per-request CSP nonce is the only part of the HTML that changes between two fetches. */
export const normalizeHtml = (html: string): string => html.replace(/ nonce="[^"]*"/g, '');

// "./x.js", "../chunks/x.js" or "/_app/x.js" inside quotes: SvelteKit's import() starts and Vite's imports.
const JS_REF = /["'`]((?:\.{1,2}\/|\/)[^"'`\s]+?\.js)["'`]/g;

/** Same-origin script pathnames referenced by `text`, resolved against `base`. */
export function scriptRefs(text: string, base: string): string[] {
  const origin = new URL(base).origin;
  const out = new Set<string>();
  for (const m of text.matchAll(JS_REF)) {
    const u = new URL(m[1], base);
    if (u.origin === origin) out.add(u.pathname);
  }
  return [...out];
}

export async function fingerprint(pageUrl: string, fetcher: Fetcher, maxScripts: number): Promise<Fingerprint> {
  const page = new URL(pageUrl);
  const res = await fetcher(page.href);
  if (!res.ok) throw new Error(`${page.pathname}: HTTP ${res.status}`);
  const html = await res.text();
  const scripts: Record<string, string> = {};
  const queue = scriptRefs(html, page.href);
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    if (p in scripts) continue;
    // Free Workers allow 50 subrequests per run: 44 scripts + page + 2 views (+2 retries) + 1 alert. Too many must alert, never pass.
    if (Object.keys(scripts).length >= maxScripts) throw new Error(`the page loads more than ${maxScripts} scripts; raise MAX_SCRIPTS (needs Workers Paid above 44)`);
    const url = new URL(p, page.origin).href;
    const r = await fetcher(url);
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    const body = await r.arrayBuffer();
    scripts[p] = await sha256(body);
    queue.push(...scriptRefs(new TextDecoder().decode(body), url));
  }
  const sorted = Object.fromEntries(Object.entries(scripts).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { page: page.pathname, html: await sha256(new TextEncoder().encode(normalizeHtml(html))), scripts: sorted };
}

export function bundleFindings(live: Fingerprint, ex: Fingerprint | null): string[] {
  if (!ex) return ['NO EXPECTED FINGERPRINT for this network: run scripts/deploy-web.sh to record one'];
  const f: string[] = [];
  if (live.html !== ex.html) f.push(`CLAIM PAGE HTML CHANGED: ${live.page}`);
  for (const [p, h] of Object.entries(live.scripts)) {
    if (!(p in ex.scripts)) f.push(`SCRIPT ADDED: ${p}`);
    else if (ex.scripts[p] !== h) f.push(`SCRIPT CHANGED: ${p}`);
  }
  for (const p of Object.keys(ex.scripts)) if (!(p in live.scripts)) f.push(`SCRIPT GONE: ${p}`);
  return f;
}
