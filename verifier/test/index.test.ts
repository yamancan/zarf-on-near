import { describe, expect, it } from 'vitest';
import vectors from '../../spec/vectors.json';
import worker from '../src/index';

const env = {
  GOOGLE_CLIENT_ID: 'client-123', CONTRACT_ID: 'zarf-near.testnet', SIGNER_SEED: vectors.keys.signer_seed,
  CLAIM_ORIGINS: 'http://localhost:5173, https://claim.example',
};
const req = (method: string, body?: string, origin = 'https://claim.example', path = '/claim', e = env) =>
  worker.fetch(new Request(`https://v.test${path}`, { method, body, headers: { Origin: origin } }), e);

describe('worker', () => {
  it('404s other routes and methods', async () => {
    expect((await req('POST', '{}', undefined, '/x')).status).toBe(404);
    expect((await req('GET')).status).toBe(404);
  });

  it('answers the CORS preflight for a configured origin only', async () => {
    const ok = await req('OPTIONS');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://claim.example');
    expect(ok.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect((await req('OPTIONS', undefined, 'https://evil.example')).headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('adds CORS to error responses too, so the app can read them', async () => {
    const res = await req('POST', 'not json', 'http://localhost:5173');
    expect(res.status).toBe(400);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
  });

  it('400s a bad destination before any token work', async () => {
    const res = await req('POST', JSON.stringify({ id_token: 'a.b', destination: 'Alice.testnet' }));
    expect(await res.json()).toEqual({ error: 'BAD_DESTINATION' });
  });

  it('500s, without signing, when the signer seed or contract id is missing', async () => {
    const res = await req('POST', '{"id_token":"a.b"}', undefined, '/claim', { ...env, SIGNER_SEED: '' });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'VERIFIER_MISCONFIGURED' });
  });
});
