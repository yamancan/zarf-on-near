import { unstable_dev } from 'wrangler';
import { expect, it } from 'vitest';

it('relays a signed claim and refuses a forged one inside workerd', async () => {
  const worker = await unstable_dev('test/workerd/entry.ts', { config: 'test/workerd/wrangler.json', experimental: { disableExperimentalWarning: true } });
  try {
    const { good, forged } = (await (await worker.fetch('/')).json()) as { good: { status: number; body: { tx_hash?: string; status?: string } }; forged: unknown };
    expect(good.status).toBe(200);
    expect(good.body.status).toBe('paid');
    expect(good.body.tx_hash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{40,50}$/);
    expect(forged).toEqual({ status: 403, body: { error: 'E101_INVALID_SIGNATURE' } });
    expect(await (await worker.fetch('/starter')).json()).toMatchObject({ result: 'pending' });
    // Let the real workerd alarm (not an explicit call to alarm()) finish the late claim.
    await expect.poll(async () => (await (await worker.fetch('/starter-result')).json() as { mark: unknown }).mark,
      { timeout: 60_000, interval: 100 }).toBe('1');
  } finally {
    await worker.stop();
  }
}, 180_000);
