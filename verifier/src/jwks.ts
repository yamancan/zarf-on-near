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
  let fetchedAt = -Infinity; // last successful fetch
  let attemptedAt = -Infinity; // last fetch, failed or not: MIN_REFRESH_MS also throttles an outage
  let lastError: unknown = null;

  async function refresh(): Promise<void> {
    attemptedAt = now();
    try {
      const res = await fetchFn(url);
      if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
      const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string; use?: string })[] };
      const next = new Map<string, CryptoKey>();
      for (const jwk of body.keys ?? []) {
        if (jwk.kty !== 'RSA' || !jwk.kid || (jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
        try {
          next.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
        } catch {
          continue; // one odd key must not take down the others
        }
      }
      keys = next;
      fetchedAt = attemptedAt;
      lastError = null;
    } catch (e) {
      lastError = e;
      throw e;
    }
  }

  return async (kid) => {
    const t = now();
    const stale = t - fetchedAt > MAX_AGE_MS;
    if ((stale || !keys.has(kid)) && t - attemptedAt > MIN_REFRESH_MS) await refresh();
    else if (stale && lastError) throw lastError; // fail closed without re-fetching during an outage
    return keys.get(kid);
  };
}
