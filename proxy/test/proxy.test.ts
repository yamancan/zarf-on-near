import { describe, expect, it } from 'vitest';
import { FAUCET_PATHS, proxy, type Env } from '../src/index';

const env: Env = { CLAIM_ORIGIN: 'https://claim.example.workers.dev', FAUCET_ORIGIN: 'https://faucet.example.workers.dev', PROXY_KEY: 'k' };

/** A fake upstream: records the request, answers with the given response. */
function upstream(res: () => Response) {
  const seen: { url: string; init: RequestInit; headers: Headers }[] = [];
  const fetchFn = (async (u: string, i: RequestInit) => (seen.push({ url: u, init: i, headers: new Headers(i.headers) }), res())) as typeof fetch;
  return { seen, fetchFn };
}

describe('path routing', () => {
  it.each([
    ['/', 'https://claim.example.workers.dev/'],
    ['/create', 'https://claim.example.workers.dev/create'],
    ['/claim/3/abc?x=1', 'https://claim.example.workers.dev/claim/3/abc?x=1'],
    ['/auth/google', 'https://claim.example.workers.dev/auth/google'],
    ['/favicon.svg', 'https://claim.example.workers.dev/favicon.svg'],
    ['/try', 'https://faucet.example.workers.dev/try'],
    ['/try.js', 'https://faucet.example.workers.dev/try.js'],
    ['/health', 'https://faucet.example.workers.dev/health'],
    ['/saira.woff2', 'https://faucet.example.workers.dev/saira.woff2'],
    ['/faucet', 'https://faucet.example.workers.dev/faucet'],
    ['/try/', 'https://claim.example.workers.dev/try/'], // exact paths only
  ])('%s → %s', async (path, want) => {
    const u = upstream(() => new Response('ok'));
    await proxy(new Request('https://near.zarf.to' + path), env, u.fetchFn);
    expect(u.seen[0].url).toBe(want);
  });
  it('the faucet paths match the faucet worker', () => expect([...FAUCET_PATHS].sort()).toEqual(['/faucet', '/health', '/saira.woff2', '/try', '/try.js']));
  it.each([
    '//attacker.invalid/login?next=%2Fclaim',
    '///attacker.invalid/login',
    '/\\attacker.invalid/login',
    '/%2Fattacker.invalid/login',
    '/%5Cattacker.invalid/login',
    '//attacker.invalid/faucet?email=synthetic',
  ])('keeps an authority-like path on the configured upstream: %s', async (path) => {
    const req = new Request('https://near.zarf.to' + path);
    const incoming = new URL(req.url);
    const u = upstream(() => new Response('trusted app'));
    await proxy(req, env, u.fetchFn);
    const target = new URL(u.seen[0].url);
    expect(target.origin).toBe(env.CLAIM_ORIGIN);
    expect(target.pathname).toBe(incoming.pathname);
    expect(target.search).toBe(incoming.search);
    expect(u.seen[0].headers.has('x-zarf-proxy-key')).toBe(false);
  });
});

describe('pass-through', () => {
  it('method, body and request headers go unchanged; the upstream sets its own Host', async () => {
    const u = upstream(() => new Response('{}', { status: 201 }));
    const body = JSON.stringify({ email: 'a@x.io', turnstile: 't' });
    await proxy(new Request('https://near.zarf.to/faucet', { method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'x/y' } }), env, u.fetchFn);
    const s = u.seen[0];
    expect(s.init.method).toBe('POST');
    expect(new TextDecoder().decode(s.init.body as ArrayBuffer)).toBe(body);
    expect(s.headers.get('content-type')).toBe('application/json');
    expect(s.headers.get('accept')).toBe('x/y');
    expect(s.headers.has('host')).toBe(false);
    expect(s.headers.get('x-forwarded-host')).toBe('near.zarf.to');
    expect(s.init.redirect).toBe('manual');
  });
  it('status, body and response headers come back unchanged', async () => {
    const u = upstream(() => new Response('<p>hi</p>', { status: 404, headers: { 'Content-Security-Policy': "default-src 'self'", 'X-Test': '1' } }));
    const r = await proxy(new Request('https://near.zarf.to/nope'), env, u.fetchFn);
    expect(r.status).toBe(404);
    expect(await r.text()).toBe('<p>hi</p>');
    expect(r.headers.get('content-security-policy')).toBe("default-src 'self'");
    expect(r.headers.get('x-test')).toBe('1');
  });
  it('HTML is never cached here; other files keep their cache headers', async () => {
    const html = upstream(() => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=600' } }));
    expect((await proxy(new Request('https://near.zarf.to/'), env, html.fetchFn)).headers.get('cache-control')).toBe('no-store');
    const font = upstream(() => new Response('w', { headers: { 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=86400' } }));
    expect((await proxy(new Request('https://near.zarf.to/saira.woff2'), env, font.fetchFn)).headers.get('cache-control')).toBe('public, max-age=86400');
  });
});

describe('visitor IP for the faucet', () => {
  it('forwards CF-Connecting-IP with the shared key to the faucet only', async () => {
    const f = upstream(() => new Response('{}'));
    await proxy(new Request('https://near.zarf.to/faucet', { method: 'POST', body: '{}', headers: { 'CF-Connecting-IP': '203.0.113.7' } }), env, f.fetchFn);
    expect(f.seen[0].headers.get('x-zarf-client-ip')).toBe('203.0.113.7');
    expect(f.seen[0].headers.get('x-zarf-proxy-key')).toBe('k');
    const c = upstream(() => new Response('ok'));
    await proxy(new Request('https://near.zarf.to/claim/3/abc', { headers: { 'CF-Connecting-IP': '203.0.113.7' } }), env, c.fetchFn);
    expect(c.seen[0].headers.has('x-zarf-proxy-key')).toBe(false);
  });
  it('a visitor cannot send the proxy headers themselves', async () => {
    const u = upstream(() => new Response('{}'));
    const spoof = { 'X-Zarf-Client-IP': '1.1.1.1', 'X-Zarf-Proxy-Key': 'guess' };
    await proxy(new Request('https://near.zarf.to/faucet', { method: 'POST', body: '{}', headers: spoof }), { ...env, PROXY_KEY: undefined }, u.fetchFn);
    expect(u.seen[0].headers.has('x-zarf-client-ip')).toBe(false);
    expect(u.seen[0].headers.has('x-zarf-proxy-key')).toBe(false);
  });
});

describe('redirect Location rewrite', () => {
  it.each([
    ['https://claim.example.workers.dev/claim/3/abc/receipt?x=1#y', 'https://near.zarf.to/claim/3/abc/receipt?x=1#y'],
    ['/campaigns', 'https://near.zarf.to/campaigns'],
    ['https://accounts.google.com/o/oauth2/v2/auth?state=a', 'https://accounts.google.com/o/oauth2/v2/auth?state=a'],
  ])('%s → %s', async (loc, want) => {
    const u = upstream(() => new Response(null, { status: 302, headers: { Location: loc } }));
    const r = await proxy(new Request('https://near.zarf.to/x'), env, u.fetchFn);
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe(want);
  });
  it('a faucet redirect comes back on near.zarf.to too', async () => {
    const u = upstream(() => new Response(null, { status: 301, headers: { Location: 'https://faucet.example.workers.dev/try' } }));
    expect((await proxy(new Request('https://near.zarf.to/try'), env, u.fetchFn)).headers.get('location')).toBe('https://near.zarf.to/try');
  });
});
