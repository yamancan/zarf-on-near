import { retryWrite, type QuotaNamespace } from './quota';

/** The subset of Workers KV the encrypted recovery records need; a Map-backed fake implements it in tests. */
export interface KvLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
}

export interface Limits {
  perIpPerDay: number;
  perEmailPerDay: number;
  dailyCap: number;
}

const DAY_S = 86_400;

async function mac(limitKey: string, kind: string, value: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(limitKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${kind}:${value}`)));
}

/** Keys are HMAC(limitKey, value): neither quota storage nor KV holds an email or IP in the clear. */
async function hashed(limitKey: string, kind: string, value: string): Promise<string> {
  return Array.from((await mac(limitKey, kind, value)).subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type LimitResult =
  | { ok: true; commitEmail: () => Promise<void>; cancelEmail: () => Promise<void> }
  | { ok: false; code: 'RATE_LIMITED_IP' | 'RATE_LIMITED_EMAIL' | 'DAILY_CAP_REACHED' };

/** Reserve all three dimensions atomically before creating a campaign. Raw identities never leave this worker. */
export async function takeQuota(
  quota: QuotaNamespace, limitKey: string, limits: Limits, ip: string, canonicalEmail: string, nowMs: number,
): Promise<LimitResult> {
  const name = `day:${Math.floor(nowMs / 1000 / DAY_S)}`;
  const id = crypto.randomUUID();
  const input = { id, limits, ip: await hashed(limitKey, 'ip', ip), email: await hashed(limitKey, 'email', canonicalEmail) };
  // Recreate the stub on each retry; Cloudflare can leave a failed stub broken.
  const result = await retryWrite(() => quota.getByName(name).reserve(input));
  if (!result.ok) return result;
  return {
    ok: true,
    commitEmail: () => retryWrite(() => quota.getByName(name).commit(id)),
    cancelEmail: () => retryWrite(() => quota.getByName(name).cancel(id)),
  };
}

// The link already issued to an email today, so a judge who lost it gets the same one back instead of a lockout.
// Sealed with AES-GCM under HMAC(limitKey, email): the KV value says nothing (no email, salt or commitment) to
// anyone without both the secret and the email, so stored links stay as private as the counters.
const linkKey = async (limitKey: string, canonicalEmail: string, nowMs: number) =>
  `link:${Math.floor(nowMs / 1000 / DAY_S)}:${await hashed(limitKey, 'link', canonicalEmail)}`;
const sealKey = async (limitKey: string, canonicalEmail: string) =>
  crypto.subtle.importKey('raw', await mac(limitKey, 'seal', canonicalEmail), 'AES-GCM', false, ['encrypt', 'decrypt']);
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Retry transient KV failures; exhausted retries must never discard an already-created campaign response. */
export async function saveLink(kv: KvLike, limitKey: string, canonicalEmail: string, nowMs: number, link: Record<string, unknown>): Promise<void> {
  try {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await sealKey(limitKey, canonicalEmail), new TextEncoder().encode(JSON.stringify(link))));
    const key = await linkKey(limitKey, canonicalEmail, nowMs);
    await retryWrite(() => kv.put(key, `${b64(iv)}.${b64(ct)}`, { expirationTtl: 2 * DAY_S }), 1100);
  } catch {
    console.log('faucet_link_persist_failed'); // fixed tag; never log the encrypted link or recipient
  }
}

/** Today's link for this email, or null (none, unreadable, or sealed under another key). */
export async function readLink(kv: KvLike, limitKey: string, canonicalEmail: string, nowMs: number): Promise<Record<string, unknown> | null> {
  try {
    const v = await kv.get(await linkKey(limitKey, canonicalEmail, nowMs));
    if (!v) return null;
    const [iv, ct] = v.split('.').map(unb64);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await sealKey(limitKey, canonicalEmail), ct);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch {
    return null;
  }
}
