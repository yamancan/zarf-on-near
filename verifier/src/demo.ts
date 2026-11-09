// DEMO ENTRY, NEVER DEPLOYED AS THE VERIFIER (wrangler.demo.jsonc only).
// It replaces Google with a throwaway issuer whose RSA key is generated in memory at startup, so
// `make demo` runs the whole claim flow with no Google login and no key material in the repo.
// The release entry (src/index.ts) does not import this file and rejects these tokens.
import { destinationNonce } from './claim';
import { makeVerifier, type Env } from './worker';

export const DEMO_ISSUER = 'https://demo-issuer.zarf-near.invalid';
const KID = 'zarf-near-demo';

let pair: Promise<CryptoKeyPair> | undefined;
const keys = () =>
  (pair ??= crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>);

const b64url = (b: Uint8Array | string) =>
  btoa(String.fromCharCode(...(typeof b === 'string' ? new TextEncoder().encode(b) : b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A Google-shaped ID token from the demo issuer, bound to `destination` like a real sign-in. */
export async function mintDemoToken(o: { email: string; destination: string; audience: string; nowMs?: number }): Promise<string> {
  const now = Math.floor((o.nowMs ?? Date.now()) / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: DEMO_ISSUER, aud: o.audience, sub: 'demo', iat: now, exp: now + 600,
    email: o.email, email_verified: true, nonce: await destinationNonce(o.destination),
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', (await keys()).privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

const verifier = makeVerifier({ jwks: async (kid) => (kid === KID ? (await keys()).publicKey : undefined), issuers: [DEMO_ISSUER] });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname === '/demo/token' && req.method === 'POST') {
      const { email, destination } = (await req.json().catch(() => ({}))) as { email?: string; destination?: string };
      if (typeof email !== 'string' || typeof destination !== 'string') return Response.json({ error: 'E108_INVALID_INPUT' }, { status: 400 });
      return Response.json({ id_token: await mintDemoToken({ email, destination, audience: env.GOOGLE_CLIENT_ID }) });
    }
    return verifier.fetch(req, env);
  },
};
