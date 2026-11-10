import { describe, expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';
import worker from '../src/index';
import { MAX_BODY_BYTES } from '../src/worker';

const env = {
  GOOGLE_CLIENT_ID: 'client-123', CONTRACT_ID: 'zarf-near.testnet', NEAR_RPC_URL: 'https://rpc.test', SIGNER_SEED: vectors.keys.signer_seed,
  CLAIM_ORIGINS: 'http://localhost:5173, https://claim.example',
};
const req = (method: string, body?: string, origin = 'https://claim.example', path = '/claim', e = env) =>
  worker.fetch(new Request(`https://v.test${path}`, { method, body, headers: { Origin: origin } }), e);

describe('worker', () => {
  it('404s other routes and methods', async () => {
    expect((await req('POST', '{}', undefined, '/x')).status).toBe(404);
    expect((await req('GET')).status).toBe(404);
    expect((await req('POST', '{}', undefined, '/health')).status).toBe(404);
  });

  it('answers the CORS preflight for a configured origin only', async () => {
    const ok = await req('OPTIONS');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://claim.example');
    expect(ok.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect((await req('OPTIONS', undefined, 'https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows no origin when CLAIM_ORIGINS is unset', async () => {
    const { CLAIM_ORIGINS: _, ...unset } = env;
    const res = await req('OPTIONS', undefined, 'http://localhost:5173', '/claim', unset as typeof env);
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('adds CORS to error responses too, so the app can read them', async () => {
    const res = await req('POST', 'not json', 'http://localhost:5173');
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('413s a body over MAX_BODY_BYTES, by header or by length', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(MAX_BODY_BYTES) });
    expect((await req('POST', big)).status).toBe(413);
    const lying = new Request('https://v.test/claim', { method: 'POST', body: '{}', headers: { 'Content-Length': String(MAX_BODY_BYTES + 1) } });
    expect((await worker.fetch(lying, env)).status).toBe(413);
  });

  it('429s when the per-IP limiter refuses, before reading the body', async () => {
    const keys: string[] = [];
    const PER_IP = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) };
    const r = new Request('https://v.test/claim', { method: 'POST', body: '{}', headers: { 'CF-Connecting-IP': '203.0.113.7' } });
    const res = await worker.fetch(r, { ...env, PER_IP });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'RATE_LIMITED' });
    expect(keys).toEqual(['203.0.113.7']);
  });

  it('GET /health names the contract and the public signer, never a secret', async () => {
    const res = await req('GET', undefined, undefined, '/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ contract_id: 'zarf-near.testnet', signer: vectors.keys.signer, google_client_id_set: true });
    expect(JSON.stringify(body)).not.toContain(env.SIGNER_SEED);
  });

  it('400s a bad destination before any token work', async () => {
    const res = await req('POST', JSON.stringify({ id_token: 'a.b', destination: 'Alice.testnet' }));
    expect(await res.json()).toEqual({ error: 'BAD_DESTINATION' });
  });

  it.each([
    ['SIGNER_SEED', ''], ['CONTRACT_ID', ''], ['GOOGLE_CLIENT_ID', ''],
    ['SIGNER_SEED', 'not-hex'], ['SIGNER_SEED', 'AB'.repeat(32)], ['SIGNER_SEED', 'ab'.repeat(31)],
  ])('500s, without signing, when %s is %j', async (k, value) => {
    const res = await req('POST', '{"id_token":"a.b"}', undefined, '/claim', { ...env, [k]: value });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'VERIFIER_MISCONFIGURED' });
  });

  it('503s with CORS, signing nothing, when an upstream read fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 })); // Google's JWKS is unreachable
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const v = vectors.claims.valid[0].call_args;
      const enc = (o: object) => btoa(JSON.stringify(o)).replace(/=+$/, '');
      const token = `${enc({ alg: 'RS256', kid: 'k1' })}.${enc({})}.AAAA`;
      const body = { id_token: token, campaign_id: v.campaign_id, commitment: v.commitment, amount: v.amount, proof: v.proof, destination: v.destination, salt: '00'.repeat(32) };
      const res = await req('POST', JSON.stringify(body));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'UPSTREAM_UNAVAILABLE' });
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://claim.example');
      expect(log).toHaveBeenCalledWith('upstream_unavailable:jwks'); // a fixed tag, nothing from the request
    } finally {
      log.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
