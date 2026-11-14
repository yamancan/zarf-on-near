/// <reference types="node" />
import { afterEach, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const instances: Miniflare[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((mf) => mf.dispose()));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function runtime(persist?: string) {
  const bundle = await build({
    stdin: { contents: `
      export { FaucetQuota } from './src/quota-object';
      export default { async fetch(req, env) {
        const { day, operation, input } = await req.json();
        const quota = env.QUOTA.getByName(day);
        const result = await quota[operation](input);
        return Response.json(result ?? null);
      } };
    `, resolveDir: process.cwd() },
    bundle: true, format: 'esm', write: false, external: ['cloudflare:workers'],
  });
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-06-01',
    durableObjects: { QUOTA: { className: 'FaucetQuota', useSQLite: true } }, resourcePersistencePath: persist }));
  instances.push(mf);
  return { mf, call: async (operation: string, input: unknown, day = 'day:1') => {
    const res = await mf.dispatchFetch('http://quota.test', { method: 'POST', body: JSON.stringify({ operation, input, day }) });
    expect(res.status).toBe(200);
    return res.json();
  } };
}
const reservation = (id: string, overrides = {}) => ({ id, ip: `ip-${id}`, email: `email-${id}`,
  limits: { perIpPerDay: 2, perEmailPerDay: 1, dailyCap: 1 }, ...overrides });

it('real SQLite admits one concurrent reservation and preserves the daily cap across restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'zarf-quota-'));
  directories.push(directory);
  const first = await runtime(directory);
  const replies = await Promise.all(Array.from({ length: 12 }, (_, i) => first.call('reserve', reservation(String(i)))));
  expect(replies.filter((r: any) => r.ok)).toHaveLength(1);
  await first.mf.dispose();
  instances.splice(instances.indexOf(first.mf), 1);
  const second = await runtime(directory);
  const winner = replies.findIndex((r: any) => r.ok);
  expect(await second.call('reserve', reservation('same-email', { email: `email-${winner}` })))
    .toEqual({ ok: false, code: 'RATE_LIMITED_EMAIL' });
  expect(await second.call('reserve', reservation('after-restart'))).toEqual({ ok: false, code: 'DAILY_CAP_REACHED' });
  expect(await second.call('reserve', reservation('next-day'), 'day:2')).toEqual({ ok: true });
}, 20_000);

it('real RPC reserve/commit/cancel replays cannot double charge or release a committed email', async () => {
  const { call } = await runtime();
  const input = reservation('one', { limits: { perIpPerDay: 2, perEmailPerDay: 1, dailyCap: 2 } });
  expect(await call('reserve', input)).toEqual({ ok: true });
  expect(await call('reserve', input)).toEqual({ ok: true });
  await call('commit', 'one');
  await call('commit', 'one');
  await call('cancel', 'one');
  expect(await call('reserve', { ...input, id: 'two', ip: 'another' })).toEqual({ ok: false, code: 'RATE_LIMITED_EMAIL' });
  expect(await call('reserve', { ...input, id: 'three', ip: 'another', email: 'different' })).toEqual({ ok: true });
}, 20_000);
