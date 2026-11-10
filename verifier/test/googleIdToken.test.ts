import { beforeAll, describe, expect, it, vi } from 'vitest';
import { destinationNonce } from '../src/claim';
import { TokenError, verifyGoogleIdToken } from '../src/googleIdToken';
import { remoteJwks } from '../src/jwks';

// Self-signed RSA keys stand in for Google's: no network, no real tokens.
const RSA = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' };
const b64url = (b: Uint8Array | string) =>
  btoa(String.fromCharCode(...(typeof b === 'string' ? new TextEncoder().encode(b) : b)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

interface Signer { kid: string; key: CryptoKey; jwk: JsonWebKey }
async function signer(kid: string): Promise<Signer> {
  const kp = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
  return { kid, key: kp.privateKey, jwk: { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid, alg: 'RS256', use: 'sig' } as JsonWebKey };
}
async function sign(s: Signer, payload: object, header: object = { alg: 'RS256', kid: s.kid, typ: 'JWT' }) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', s.key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}
const jwksResponse = (...signers: Signer[]) => new Response(JSON.stringify({ keys: signers.map((s) => s.jwk) }));

const NOW = 1_763_150_000_000;
const CLIENT_ID = 'client-123.apps.googleusercontent.com';
const DEST = 'alice.testnet';

let google: Signer, other: Signer, claims: Record<string, unknown>;
beforeAll(async () => {
  [google, other] = await Promise.all([signer('k1'), signer('k2')]);
  claims = {
    iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1', exp: NOW / 1000 + 600, iat: NOW / 1000,
    email: 'Alice@Example.com', email_verified: true, nonce: await destinationNonce(DEST),
  };
});

const verify = (token: string, destination = DEST) =>
  verifyGoogleIdToken(token, { clientId: CLIENT_ID, destination, nowMs: NOW, jwks: remoteJwks('x', async () => jwksResponse(google), () => NOW) });
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof TokenError ? e.code : `THREW ${e}`));

describe('verifyGoogleIdToken', () => {
  it('accepts a valid token and returns the canonical email', async () => {
    expect(await verify(await sign(google, claims))).toEqual({ email: 'alice@example.com' });
  });

  it('accepts both Google issuer forms', async () => {
    expect(await code(verify(await sign(google, { ...claims, iss: 'accounts.google.com' })))).toBe('OK');
  });

  it('keeps dots and plus tags (no folding)', async () => {
    const t = await sign(google, { ...claims, email: ' A.B+tag@Gmail.com ' });
    expect(await verify(t)).toEqual({ email: 'a.b+tag@gmail.com' });
  });

  it('accepts exp inside the 60 s skew', async () => {
    expect(await code(verify(await sign(google, { ...claims, exp: NOW / 1000 - 30 })))).toBe('OK');
  });

  it.each<[string, string, () => Promise<string>]>([
    ['MALFORMED', 'two segments', async () => 'a.b'],
    ['MALFORMED', 'garbage json', async () => 'e30.bm90LWpzb24.AA'],
    ['BAD_ALG', 'alg none', () => sign(google, claims, { alg: 'none', kid: 'k1' })],
    ['BAD_ALG', 'alg HS256', () => sign(google, claims, { alg: 'HS256', kid: 'k1' })],
    ['UNKNOWN_KID', 'missing kid', () => sign(google, claims, { alg: 'RS256' })],
    ['UNKNOWN_KID', 'kid not in JWKS', () => sign(other, claims)],
    ['BAD_SIGNATURE', 'signed by another key under a known kid', () => sign({ ...other, kid: 'k1' }, claims)],
    ['BAD_SIGNATURE', 'payload swapped after signing', async () => {
      const [h, , s] = (await sign(google, claims)).split('.');
      return `${h}.${b64url(JSON.stringify({ ...claims, email: 'mallory@example.com' }))}.${s}`;
    }],
    ['BAD_ISSUER', 'other issuer', () => sign(google, { ...claims, iss: 'https://evil.example' })],
    ['BAD_ISSUER', 'issuer missing', () => sign(google, { ...claims, iss: undefined })],
    ['BAD_AUDIENCE', 'other client', () => sign(google, { ...claims, aud: 'other-client' })],
    ['BAD_AUDIENCE', 'aud array', () => sign(google, { ...claims, aud: [CLIENT_ID] })],
    ['EXPIRED', 'exp beyond skew', () => sign(google, { ...claims, exp: NOW / 1000 - 61 })],
    ['EXPIRED', 'exp missing', () => sign(google, { ...claims, exp: undefined })],
    ['EXPIRED', 'exp as string', () => sign(google, { ...claims, exp: String(NOW / 1000 + 600) })],
    ['EMAIL_NOT_VERIFIED', 'email_verified false', () => sign(google, { ...claims, email_verified: false })],
    ['EMAIL_NOT_VERIFIED', 'email_verified "true" string', () => sign(google, { ...claims, email_verified: 'true' })],
    ['NO_EMAIL', 'email missing', () => sign(google, { ...claims, email: undefined })],
    ['BAD_NONCE', 'nonce for another destination', async () => sign(google, { ...claims, nonce: await destinationNonce('bob.testnet') })],
    ['BAD_NONCE', 'uppercase nonce', async () => sign(google, { ...claims, nonce: (await destinationNonce(DEST)).toUpperCase() })],
    ['BAD_NONCE', 'nonce missing', () => sign(google, { ...claims, nonce: undefined })],
  ])('rejects %s: %s', async (expected, _, make) => {
    expect(await code(verify(await make()))).toBe(expected);
  });

  it('rejects a valid token presented for another destination', async () => {
    expect(await code(verify(await sign(google, claims), 'bob.testnet'))).toBe('BAD_NONCE');
  });

  it('refuses to run without a client id', async () => {
    const t = await sign(google, claims);
    await expect(verifyGoogleIdToken(t, { clientId: '', destination: DEST, jwks: async () => undefined })).rejects.toThrow('misconfigured');
  });
});

describe('remoteJwks', () => {
  it('caches, refreshes on a kid miss, and rate-limits refreshes', async () => {
    let now = NOW, served = [google];
    const fetchFn = vi.fn(async () => jwksResponse(...served));
    const jwks = remoteJwks('x', fetchFn, () => now);

    expect(await jwks('k1')).toBeDefined();
    expect(await jwks('k1')).toBeDefined();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    served = [google, other]; // Google rotates in k2
    expect(await jwks('k2')).toBeUndefined(); // miss inside 30 s: no refetch
    expect(fetchFn).toHaveBeenCalledTimes(1);
    now += 31_000;
    expect(await jwks('k2')).toBeDefined(); // miss after 30 s: refetch
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('drops a withdrawn key after the hourly refresh', async () => {
    let now = NOW, served = [google];
    const jwks = remoteJwks('x', async () => jwksResponse(...served), () => now);
    expect(await jwks('k1')).toBeDefined();
    served = [other];
    now += 3_600_001;
    expect(await jwks('k1')).toBeUndefined();
  });

  it('fails closed when the JWKS endpoint errors', async () => {
    const jwks = remoteJwks('x', async () => new Response('down', { status: 503 }));
    await expect(jwks('k1')).rejects.toThrow('HTTP 503');
  });
});
