import { expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';

// A bug in the claim flow (not an upstream outage) must surface as the runtime's 500, never as a 503.
vi.mock('../src/claimFlow', () => ({
  handleClaim: async () => {
    throw new TypeError('a bug, not an outage');
  },
}));
const { default: worker } = await import('../src/index');

it('lets a non-upstream error escape (500), instead of reporting UPSTREAM_UNAVAILABLE', async () => {
  const env = { GOOGLE_CLIENT_ID: 'c', CONTRACT_ID: 'zarf-near.testnet', NEAR_RPC_URL: 'https://rpc.test', SIGNER_SEED: vectors.keys.signer_seed, CLAIM_ORIGINS: '' };
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const req = new Request('https://v.test/claim', { method: 'POST', body: '{}' });
  await expect(worker.fetch(req, env)).rejects.toThrow(TypeError);
  expect(log).not.toHaveBeenCalled();
  log.mockRestore();
});
