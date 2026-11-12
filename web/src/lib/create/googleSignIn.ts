// Will this address likely sign in with Google? A hint for the sender only: it never blocks sending,
// because anyone can also make a Google account on any existing address.

export const DOH_ORIGIN = 'https://dns.google'; // JSON DNS-over-HTTPS, CORS open; hooks.server.ts adds it to connect-src on /create
const GOOGLE_MAIL = new Set(['gmail.com', 'googlemail.com']);
// Workspace MX hosts: aspmx.l.google.com and its alts, smtp.google.com, aspmx2.googlemail.com.
const GOOGLE_MX = /(^|\.)(google|googlemail)\.com\.?$/i;

const cache = new Map<string, Promise<boolean>>(); // domain → uses Google mail; failed lookups are not kept

async function lookup(domain: string, fetchFn: typeof fetch): Promise<boolean> {
  const res = await fetchFn(`${DOH_ORIGIN}/resolve?name=${encodeURIComponent(domain)}&type=MX`);
  if (!res.ok) throw new Error(`DoH ${res.status}`);
  const body = (await res.json()) as { Status?: number; Answer?: { type?: number; data?: string }[] };
  if (body.Status === 3) return false; // no such domain
  if (body.Status !== 0) throw new Error(`DNS status ${body.Status}`);
  return (body.Answer ?? []).some((a) => a.type === 15 && GOOGLE_MX.test(String(a.data ?? '').trim().split(/\s+/).pop() ?? ''));
}

/** True when the domain is Gmail or its mail runs on Google Workspace. A failed lookup resolves false (show the note). */
export function domainUsesGoogle(domain: string, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const d = domain.toLowerCase();
  if (GOOGLE_MAIL.has(d)) return Promise.resolve(true);
  let p = cache.get(d);
  if (!p) {
    p = lookup(d, fetchFn);
    cache.set(d, p);
    p.catch(() => cache.get(d) === p && cache.delete(d));
  }
  return p.catch(() => false);
}

/** Canonical emails whose domain is not known to use Google. */
export async function mayNotSignIn(emails: string[], fetchFn: typeof fetch = fetch): Promise<Set<string>> {
  // shortcut: one parallel lookup per distinct domain, no cap; add a concurrency limit if lists with hundreds of domains appear.
  const domains = [...new Set(emails.map((e) => e.slice(e.lastIndexOf('@') + 1)))];
  const google = new Map(await Promise.all(domains.map(async (d) => [d, await domainUsesGoogle(d, fetchFn)] as const)));
  return new Set(emails.filter((e) => !google.get(e.slice(e.lastIndexOf('@') + 1))));
}
