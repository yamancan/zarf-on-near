import { canonicalizeEmail, destinationNonce } from './claim';
import type { JwksSource } from './jwks';

export const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const EXP_SKEW_S = 60;

export class TokenError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export interface VerifyOptions {
  clientId: string;
  destination: string;
  jwks: JwksSource;
  nowMs?: number;
}

const fail = (code: string): never => {
  throw new TokenError(code);
};

const b64url = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** Verifies a Google ID token bound to `destination` and returns the canonical email. */
export async function verifyGoogleIdToken(token: string, opts: VerifyOptions): Promise<{ email: string }> {
  if (!opts.clientId) throw new Error('verifier misconfigured: no Google client id');

  const parts = token.split('.');
  if (parts.length !== 3) fail('MALFORMED');
  const [h, p, s] = parts;
  let header: Record<string, unknown>, payload: Record<string, unknown>, sig: Uint8Array<ArrayBuffer>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(h)));
    payload = JSON.parse(new TextDecoder().decode(b64url(p)));
    sig = b64url(s);
  } catch {
    return fail('MALFORMED');
  }

  if (header.alg !== 'RS256') fail('BAD_ALG');
  const key = typeof header.kid === 'string' ? await opts.jwks(header.kid) : undefined;
  if (!key) return fail('UNKNOWN_KID');
  const signed = new TextEncoder().encode(`${h}.${p}`);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, signed))) fail('BAD_SIGNATURE');

  if (!GOOGLE_ISSUERS.includes(payload.iss as string)) fail('BAD_ISSUER');
  if (payload.aud !== opts.clientId) fail('BAD_AUDIENCE');
  const nowS = (opts.nowMs ?? Date.now()) / 1000;
  if (typeof payload.exp !== 'number' || payload.exp + EXP_SKEW_S < nowS) fail('EXPIRED');
  if (payload.email_verified !== true) fail('EMAIL_NOT_VERIFIED');
  if (typeof payload.email !== 'string') fail('NO_EMAIL');
  if (payload.nonce !== (await destinationNonce(opts.destination))) fail('BAD_NONCE');

  try {
    return { email: canonicalizeEmail(payload.email as string) };
  } catch {
    return fail('BAD_EMAIL'); // non-ASCII: no allocation can exist for it (spec v2)
  }
}
