import { unstable_dev } from 'wrangler';
import { expect, it } from 'vitest';

// Boot both entries in workerd: an entry module may export only handlers, which Node-side tests
// cannot see (a stray named export broke the demo entry at startup once).
const boot = (script: string, config: string) =>
  unstable_dev(script, { config, vars: { CONTRACT_ID: 'c', NEAR_RPC_URL: 'http://127.0.0.1:9', SIGNER_SEED: '01'.repeat(32) }, experimental: { disableExperimentalWarning: true }, logLevel: 'none' });

it('the demo entry boots in workerd and mints a token', async () => {
  const w = await boot('src/demo.ts', 'wrangler.demo.jsonc');
  try {
    const res = await w.fetch('/demo/token', { method: 'POST', body: JSON.stringify({ email: 'a@example.com', destination: 'alice.testnet' }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id_token: string }).id_token.split('.')).toHaveLength(3);
  } finally {
    await w.stop();
  }
}, 60_000);

it('the release entry boots in workerd and has no /demo/token', async () => {
  const w = await boot('src/index.ts', 'wrangler.jsonc');
  try {
    expect((await w.fetch('/demo/token', { method: 'POST', body: '{}' })).status).toBe(404);
  } finally {
    await w.stop();
  }
}, 60_000);
