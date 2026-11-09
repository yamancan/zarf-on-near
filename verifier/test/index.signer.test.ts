import { expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';

// Echo the signer the Worker hands to the claim flow, to see which key it would sign with.
vi.mock('../src/claimFlow', () => ({
  handleClaim: async (_body: unknown, d: { signer: { signer: string } }) => ({ status: 200, body: { signer: d.signer.signer } }),
}));
const { default: worker } = await import('../src/index');
const { importSigner } = await import('../src/claim');

const base = { GOOGLE_CLIENT_ID: 'c', CONTRACT_ID: 'zarf-near.testnet', CLAIM_ORIGINS: '' };
const call = async (seed: string) => {
  const res = await worker.fetch(new Request('https://v.test/claim', { method: 'POST', body: '{}' }), { ...base, SIGNER_SEED: seed });
  return { status: res.status, body: await res.json() };
};

it('the signer cache follows SIGNER_SEED: bad -> good -> bad -> other -> good', async () => {
  const other = '07'.repeat(32);
  const otherSigner = (await importSigner(other)).signer;
  expect(await call('not-a-seed')).toEqual({ status: 500, body: { error: 'VERIFIER_MISCONFIGURED' } });
  expect(await call(vectors.keys.signer_seed)).toEqual({ status: 200, body: { signer: vectors.keys.signer } });
  expect(await call('AB'.repeat(32))).toEqual({ status: 500, body: { error: 'VERIFIER_MISCONFIGURED' } });
  expect(await call(other)).toEqual({ status: 200, body: { signer: otherSigner } }); // rotated: never the cached key
  expect(await call(vectors.keys.signer_seed)).toEqual({ status: 200, body: { signer: vectors.keys.signer } });
});
