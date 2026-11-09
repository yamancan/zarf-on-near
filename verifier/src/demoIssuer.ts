// DEMO ONLY: a throwaway token issuer whose RSA key is generated in memory at startup, so no key
// material is ever in the repo. Imported by src/demo.ts only; the release entry never imports it.
import { destinationNonce } from './claim';

export const DEMO_ISSUER = 'https://demo-issuer.zarf-near.invalid';
export const DEMO_KID = 'zarf-near-demo';

let pair: Promise<CryptoKeyPair> | undefined;
export const demoKeys = () =>
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
  const header = b64url(JSON.stringify({ alg: 'RS256', kid: DEMO_KID, typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: DEMO_ISSUER, aud: o.audience, sub: 'demo', iat: now, exp: now + 600,
    email: o.email, email_verified: true, nonce: await destinationNonce(o.destination),
  }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', (await demoKeys()).privateKey, new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

