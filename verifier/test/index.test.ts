import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const env = { GOOGLE_CLIENT_ID: 'client-123' };
const post = (body: string, path = '/claim') => worker.fetch(new Request(`https://v.test${path}`, { method: 'POST', body }), env);

describe('worker', () => {
  it('404s other routes', async () => expect((await post('{}', '/x')).status).toBe(404));
  it('400s a body without id_token and destination', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post('{"id_token":"a.b.c"}')).status).toBe(400);
  });
  it('401s a malformed token with its code', async () => {
    const res = await post('{"id_token":"a.b","destination":"alice.testnet"}');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'MALFORMED' });
  });
});
