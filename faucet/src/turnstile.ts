// Cloudflare Turnstile server-side check (siteverify). Fails closed: no token, a refused token,
// or an unreachable siteverify all stop the request before any quota is spent.

export const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Cloudflare's documented always-pass / always-fail / force-challenge test keys (sitekey and secret). */
export const isTurnstileTestKey = (k: string): boolean => /^[123]x0+AA$/.test(k);

export type TurnstileResult = 'ok' | 'failed' | 'unavailable';

export async function verifyTurnstile(
  token: unknown,
  secret: string,
  ip: string,
  hostname: string | null, // the request host the token must have been issued for; null skips (local dev, test keys say "example.com")
  fetchFn: typeof fetch = (u, i) => fetch(u, i),
): Promise<TurnstileResult> {
  if (typeof token !== 'string' || !token || token.length > 2048) return 'failed';
  const form = new URLSearchParams({ secret, response: token });
  if (ip !== 'unknown') form.set('remoteip', ip);
  try {
    const res = await fetchFn(SITEVERIFY, { method: 'POST', body: form, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return 'unavailable';
    const body = (await res.json()) as { success?: unknown; hostname?: unknown };
    if (body.success !== true) return 'failed';
    return hostname === null || body.hostname === hostname ? 'ok' : 'failed';
  } catch {
    return 'unavailable';
  }
}
