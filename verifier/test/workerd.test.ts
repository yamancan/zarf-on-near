import { unstable_dev } from 'wrangler';
import { expect, it } from 'vitest';

it('spec vectors reproduce inside workerd (HMAC, nonce, Ed25519 sign)', async () => {
  const worker = await unstable_dev('test/workerd/entry.ts', {
    config: 'test/workerd/wrangler.json',
    experimental: { disableExperimentalWarning: true },
  });
  try {
    const res = (await (await worker.fetch('/')).json()) as { checked: number; fails: string[] };
    expect(res.fails).toEqual([]);
    expect(res.checked).toBeGreaterThanOrEqual(10);
  } finally {
    await worker.stop();
  }
}, 60_000);
