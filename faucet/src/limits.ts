/** The subset of Workers KV the limiter needs; a Map-backed fake implements it in tests. */
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

/** Keys are HMAC(limitKey, value): KV never holds an email or an IP in the clear. */
async function hashed(limitKey: string, kind: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(limitKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${kind}:${value}`)));
  return Array.from(mac.subarray(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

export type LimitResult = { ok: true } | { ok: false; code: 'RATE_LIMITED_IP' | 'RATE_LIMITED_EMAIL' | 'DAILY_CAP_REACHED' };

/**
 * Checks all three counters for the current UTC day, then increments all three.
 * shortcut: KV is not atomic, so a burst of parallel requests can overshoot a limit by a few;
 * fine for test USDC. Move the counters into a Durable Object before any mainnet use.
 */
export async function takeQuota(
  kv: KvLike, limitKey: string, limits: Limits, ip: string, canonicalEmail: string, nowMs: number,
): Promise<LimitResult> {
  const day = Math.floor(nowMs / 1000 / DAY_S);
  const keys = {
    ip: `ip:${day}:${await hashed(limitKey, 'ip', ip)}`,
    email: `email:${day}:${await hashed(limitKey, 'email', canonicalEmail)}`,
    cap: `cap:${day}`,
  };
  const [ipN, emailN, capN] = await Promise.all([kv.get(keys.ip), kv.get(keys.email), kv.get(keys.cap)]).then((v) =>
    v.map((x) => Number(x ?? 0)),
  );
  if (ipN >= limits.perIpPerDay) return { ok: false, code: 'RATE_LIMITED_IP' };
  if (emailN >= limits.perEmailPerDay) return { ok: false, code: 'RATE_LIMITED_EMAIL' };
  if (capN >= limits.dailyCap) return { ok: false, code: 'DAILY_CAP_REACHED' };
  const ttl = { expirationTtl: 2 * DAY_S };
  await Promise.all([
    kv.put(keys.ip, String(ipN + 1), ttl),
    kv.put(keys.email, String(emailN + 1), ttl),
    kv.put(keys.cap, String(capN + 1), ttl),
  ]);
  return { ok: true };
}
