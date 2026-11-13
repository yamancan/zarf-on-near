// near.zarf.to: a pass-through to the NEAR app's workers in the other Cloudflare account (the zone stays where it is).
// /try and its own files and API go to the faucet; everything else to the claim app. Bodies, status and headers pass
// unchanged; a redirect to an upstream host comes back on near.zarf.to; HTML is never cached here.

export interface Env {
  CLAIM_ORIGIN: string;
  FAUCET_ORIGIN: string;
  PROXY_KEY?: string; // secret shared with the faucet
}

/** The faucet's paths (faucet/src/index.ts); its "/" stays the claim app's landing. */
export const FAUCET_PATHS = new Set(['/try', '/try.js', '/saira.woff2', '/faucet']);

/** Headers only this proxy may set: a visitor sending them is ignored. */
const OWN = ['x-zarf-client-ip', 'x-zarf-proxy-key'];

export async function proxy(req: Request, env: Env, fetchFn: typeof fetch = (u, i) => fetch(u, i)): Promise<Response> {
  const url = new URL(req.url);
  const faucet = FAUCET_PATHS.has(url.pathname);
  const upstream = new URL(faucet ? env.FAUCET_ORIGIN : env.CLAIM_ORIGIN);
  const target = new URL(url.pathname + url.search, upstream.origin);

  const headers = new Headers(req.headers);
  for (const h of [...OWN, 'host']) headers.delete(h);
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
  // A Worker subrequest arrives with Cloudflare's address, not the visitor's: the faucet's per-IP limits need the real
  // one, and trust it only with the shared key. Never sent to the claim app.
  const ip = req.headers.get('CF-Connecting-IP');
  if (faucet && env.PROXY_KEY && ip) {
    headers.set('X-Zarf-Client-IP', ip);
    headers.set('X-Zarf-Proxy-Key', env.PROXY_KEY);
  }

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const res = await fetchFn(target.href, { method: req.method, headers, body: hasBody ? await req.arrayBuffer() : undefined, redirect: 'manual' });

  const out = new Response(res.body, res);
  const loc = res.headers.get('Location');
  if (loc) {
    const l = new URL(loc, target);
    if (l.origin === upstream.origin) out.headers.set('Location', url.origin + l.pathname + l.search + l.hash);
  }
  if ((res.headers.get('Content-Type') ?? '').toLowerCase().startsWith('text/html')) out.headers.set('Cache-Control', 'no-store');
  return out;
}

export default { fetch: (req: Request, env: Env) => proxy(req, env) };
