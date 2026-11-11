import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';
import worker from '../src/index';
import { base58Encode } from '../src/near';

const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
const GOOD_KEY = `ed25519:${base58Encode(unhex(vectors.keys.signer_seed + vectors.keys.signer))}`;
const MISMATCHED_KEY = `ed25519:${base58Encode(unhex(vectors.keys.signer_seed + vectors.keys.rogue_signer))}`;

const allow = { limit: async () => ({ success: true }) };
const env = {
  NETWORK: 'testnet', CONTRACT_ID: 'zarf-near.testnet', RELAYER_ACCOUNT_ID: 'relayer.testnet', NEAR_RPC_URL: 'https://rpc.test',
  VERIFIER_SIGNERS: 'ab'.repeat(32), CLAIM_ORIGINS: 'https://claim.example', RELAYER_KEY: GOOD_KEY, PER_IP: allow, PER_COMMITMENT: allow,
};
const req = (method: string, e = env, path = '/claim') =>
  worker.fetch(new Request(`https://r.test${path}`, { method, body: method === 'POST' ? '{}' : undefined, headers: { Origin: 'https://claim.example' } }), e);

beforeEach(() => void vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('relayer worker', () => {
  it('a rejected key parse is not cached: the next request with a good key gets past the gate', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bad = await req('POST', { ...env, RELAYER_KEY: MISMATCHED_KEY });
    expect(await bad.json()).toEqual({ error: 'RELAYER_MISCONFIGURED' });
    const good = await req('POST', env); // body '{}' -> refused by shape, after the key gate
    expect(await good.json()).toEqual({ error: 'E108_INVALID_INPUT' });
    const badAgain = await req('POST', { ...env, RELAYER_KEY: MISMATCHED_KEY }); // a cached good key is not reused for another secret
    expect(await badAgain.json()).toEqual({ error: 'RELAYER_MISCONFIGURED' });
    log.mockRestore();
  });

  it('404s other routes and methods', async () => {
    expect((await req('POST', env, '/x')).status).toBe(404);
    expect((await req('POST', env, '/health')).status).toBe(404);
    expect((await req('GET', env, '/claim')).status).toBe(404);
  });
  it('answers the CORS preflight for the claim app', async () => {
    const res = await req('OPTIONS');
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://claim.example');
  });
  it.each([
    ['RELAYER_KEY', ''], ['CONTRACT_ID', ''], ['RELAYER_ACCOUNT_ID', ''], ['NEAR_RPC_URL', ''], ['VERIFIER_SIGNERS', ''],
    ['RELAYER_KEY', 'ed25519:x'], ['RELAYER_KEY', GOOD_KEY.slice(8)], ['RELAYER_KEY', MISMATCHED_KEY], ['RELAYER_KEY', MISMATCHED_KEY],
  ])('500s when %s is %j (a bad key is never cached as an outage)', async (k, value) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await req('POST', { ...env, [k]: value });
    log.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'RELAYER_MISCONFIGURED' });
  });
});
