import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const allow = { limit: async () => ({ success: true }) };
const env = {
  NETWORK: 'testnet', CONTRACT_ID: 'zarf-near.testnet', RELAYER_ACCOUNT_ID: 'relayer.testnet', NEAR_RPC_URL: 'https://rpc.test',
  VERIFIER_SIGNERS: 'ab'.repeat(32), CLAIM_ORIGINS: 'https://claim.example', RELAYER_KEY: 'ed25519:x', PER_IP: allow, PER_COMMITMENT: allow,
};
const req = (method: string, e = env, path = '/claim') =>
  worker.fetch(new Request(`https://r.test${path}`, { method, body: method === 'POST' ? '{}' : undefined, headers: { Origin: 'https://claim.example' } }), e);

describe('relayer worker', () => {
  it('404s other routes', async () => expect((await req('POST', env, '/x')).status).toBe(404));
  it('answers the CORS preflight for the claim app', async () => {
    const res = await req('OPTIONS');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://claim.example');
  });
  it.each(['RELAYER_KEY', 'CONTRACT_ID', 'RELAYER_ACCOUNT_ID', 'NEAR_RPC_URL', 'VERIFIER_SIGNERS'])('500s when %s is unset', async (k) => {
    const res = await req('POST', { ...env, [k]: '' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'RELAYER_MISCONFIGURED' });
  });
});
