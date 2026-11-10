/** Resolves a JWT `kid` to an RS256 verification key, or undefined if the issuer has no such key. */
export type JwksSource = (kid: string) => Promise<CryptoKey | undefined>;

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

const MAX_AGE_MS = 60 * 60 * 1000; // re-fetch hourly so a key Google withdraws stops verifying
const MIN_REFRESH_MS = 30 * 1000; // an unknown kid cannot make us hammer the JWKS endpoint

/** JWKS fetched from `url`, cached, and refreshed on a kid miss. Never pinned. */
export function remoteJwks(
  url: string,
  fetchFn: (url: string) => Promise<Response> = (u) => fetch(u),
  now: () => number = Date.now,
): JwksSource {
  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;

  async function refresh(): Promise<void> {
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] };
    const next = new Map<string, CryptoKey>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== 'RSA' || !jwk.kid) continue;
      const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      next.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, alg, false, ['verify']));
    }
    keys = next;
    fetchedAt = now();
  }

  return async (kid) => {
    const age = now() - fetchedAt;
    if (age > MAX_AGE_MS || (!keys.has(kid) && age > MIN_REFRESH_MS)) await refresh();
    return keys.get(kid);
  };
}
