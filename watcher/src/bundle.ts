// Fingerprint of the live claim page: its HTML (CSP nonces removed) and every same-origin script it
// loads, followed through static and dynamic imports. No imports: scripts/fingerprint.ts runs this under Node.
//
// Two halves (T-026). At deploy, scripts/fingerprint.ts crawls every script with no subrequest limit and
// records them all (watcher/expected/<network>.json), after checking each one against the local build. Each
// cron run can only fetch so much (free Workers: 50 subrequests), so checkPage() re-reads the HTML and
// re-hashes `perRun` recorded scripts: a scheduled slice (3/4 of them) that rotates so every script is re-hashed
// within ceil(scripts / slice) runs, plus a random sample of the rest (1/4), so an origin that knows the
// schedule still cannot tell which skipped paths are safe to tamper with in this slot. Anything a fetched file
// names that is not recorded is reported at once. Not covered: an origin serving the watcher other bytes
// than it serves users (per-request cloaking), or a change reverted before any run looks.

export interface Fingerprint {
  page: string;
  html: string;
  /** pathname -> sha256 hex of the bytes served */
  scripts: Record<string, string>;
}

type Fetcher = (url: string) => Promise<Response>;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256 = async (data: ArrayBuffer | Uint8Array): Promise<string> => hex(await crypto.subtle.digest('SHA-256', data as BufferSource));
const htmlHash = (html: string) => sha256(new TextEncoder().encode(normalizeHtml(html)));

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

async function getPage(pageUrl: string, fetcher: Fetcher): Promise<{ page: URL; html: string }> {
  const page = new URL(pageUrl);
  const res = await fetcher(page.href);
  if (!res.ok) throw new Error(`${page.pathname}: HTTP ${res.status}`);
  return { page, html: await res.text() };
}

/** The whole page, every script (deploy time, under Node). More than `maxScripts` is an error, never a partial list. */
export async function fingerprint(pageUrl: string, fetcher: Fetcher, maxScripts = 2000): Promise<Fingerprint> {
  const { page, html } = await getPage(pageUrl, fetcher);
  const scripts: Record<string, string> = {};
  const queue = scriptRefs(html, page.href);
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    if (p in scripts) continue;
    if (Object.keys(scripts).length >= maxScripts) throw new Error(`the page loads more than ${maxScripts} scripts`);
    const url = new URL(p, page.origin).href;
    const r = await fetcher(url);
    if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`);
    const body = await r.arrayBuffer();
    scripts[p] = await sha256(body);
    queue.push(...scriptRefs(new TextDecoder().decode(body), url));
  }
  const sorted = Object.fromEntries(Object.entries(scripts).sort(([a], [b]) => (a < b ? -1 : 1)));
  return { page: page.pathname, html: await htmlHash(html), scripts: sorted };
}

/**
 * The `perRun` recorded paths that run number `run` re-hashes: consecutive in sorted order, starting where the
 * previous run stopped, so any ceil(n / perRun) consecutive runs cover every path.
 */
export function rotation(paths: string[], perRun: number, run: number): string[] {
  if (!(perRun >= 1)) throw new Error(`scripts per run must be at least 1, got ${perRun}`);
  if (paths.length <= perRun) return paths;
  const start = (((run * perRun) % paths.length) + paths.length) % paths.length;
  return Array.from({ length: perRun }, (_, i) => paths[(start + i) % paths.length]);
}

const cryptoRandom = (n: number): number => crypto.getRandomValues(new Uint32Array(1))[0] % n;

/**
 * The recorded scripts run `run` re-hashes: the scheduled slice (perRun minus a quarter, at least 1), which covers
 * every path within ceil(n / slice) runs, plus perRun minus slice others drawn at random from the rest.
 */
export function pick(paths: string[], perRun: number, run: number, random: (n: number) => number = cryptoRandom): string[] {
  if (paths.length <= perRun) return paths;
  const slice = Math.max(1, perRun - Math.floor(perRun / 4));
  const scheduled = rotation(paths, slice, run);
  const rest = paths.filter((p) => !scheduled.includes(p));
  const extra = Math.min(perRun - slice, rest.length);
  for (let i = 0; i < extra; i++) {
    const j = i + random(rest.length - i); // partial Fisher-Yates
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [...scheduled, ...rest.slice(0, extra)];
}

/** One cron run's check of the live page against the record: HTML every run, `perRun` scripts per run. */
export async function checkPage(
  pageUrl: string,
  fetcher: Fetcher,
  ex: Fingerprint | null,
  perRun: number,
  run: number,
  random: (n: number) => number = cryptoRandom,
): Promise<string[]> {
  if (!ex) return ['NO EXPECTED FINGERPRINT for this network: run scripts/deploy-web.sh to record one'];
  const { page, html } = await getPage(pageUrl, fetcher);
  const f = new Set<string>();
  if ((await htmlHash(html)) !== ex.html) f.add(`CLAIM PAGE HTML CHANGED: ${page.pathname}`);
  for (const p of scriptRefs(html, page.href)) if (!(p in ex.scripts)) f.add(`SCRIPT ADDED: ${p} (named by the page)`);
  for (const p of pick(Object.keys(ex.scripts).sort(), perRun, run, random)) {
    const url = new URL(p, page.origin).href;
    const r = await fetcher(url);
    if (!r.ok) {
      f.add(`SCRIPT NOT SERVED: ${p} (HTTP ${r.status})`);
      continue;
    }
    const body = await r.arrayBuffer();
    if ((await sha256(body)) !== ex.scripts[p]) f.add(`SCRIPT CHANGED: ${p}`);
    for (const q of scriptRefs(new TextDecoder().decode(body), url)) if (!(q in ex.scripts)) f.add(`SCRIPT ADDED: ${q} (imported by ${p})`);
  }
  return [...f];
}
