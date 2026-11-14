import { describe, expect, it } from 'vitest';
import { emailAll, notifyOne } from './mailer';

const r = (i: number) => ({ email: `u${i}@gmail.com`, amount: '1000000', salt: 'a'.repeat(64), commitment: String(i).padStart(64, '0'), proof: [] });
const reply = (status: number) => async () => new Response('{}', { status });

describe('notifyOne', () => {
  it('posts exactly the leaf fields and maps the answers', async () => {
    let body: unknown;
    const f = (async (_u: string, i: RequestInit) => ((body = JSON.parse(String(i.body))), new Response('{}', { status: 200 }))) as unknown as typeof fetch;
    expect(await notifyOne('https://m', '7', r(1), f)).toBe('sent');
    expect(body).toEqual({ campaign_id: '7', email: 'u1@gmail.com', salt: 'a'.repeat(64), amount: '1000000', proof: [] });
    expect(await notifyOne('https://m', '7', r(1), reply(409) as never)).toBe('claimed');
    expect(await notifyOne('https://m', '7', r(1), reply(410) as never)).toBe('closed');
    for (const s of [403, 429, 500, 502, 503]) expect(await notifyOne('https://m', '7', r(1), reply(s) as never)).toBe('failed');
    expect(await notifyOne('https://m', '7', r(1), (async () => { throw new Error('offline'); }) as never)).toBe('failed');
  });
});

describe('emailAll', () => {
  it('every row ends with one status, at most N calls in flight', async () => {
    let inFlight = 0, peak = 0;
    const f = (async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((ok) => setTimeout(ok, 5));
      inFlight--;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const seen = new Map<string, string>();
    await emailAll('https://m', '7', Array.from({ length: 10 }, (_, i) => r(i)), (c, s) => seen.set(c, s), { concurrency: 3, fetchFn: f });
    expect(peak).toBeLessThanOrEqual(3);
    expect([...seen.values()].every((s) => s === 'sent')).toBe(true);
    expect(seen.size).toBe(10);
  });
});
