import { describe, expect, it, vi } from 'vitest';
import { contractFindings, type WatchView } from '../src/contract.ts';
import { bundleFindings, fingerprint, normalizeHtml, scriptRefs } from '../src/bundle.ts';
import { alert, EXPECTED, run, type Env } from '../src/index.ts';
import clean from './fixtures/watch-clean.json';
import proposed from './fixtures/watch-proposed.json';
import cancelled from './fixtures/watch-cancelled.json';
import expectedLocal from './local/expected.json';
import { siteResponse, viewResponse, type Variant } from './fixtures/site.ts';

const OWNER = 'zarf-near-owner-1111.testnet';
const SIGNER = '2d10ebec1ec795cef82b8d357cc60d39d9119b99908741660b632fc5cf0d4e32';
const ex = { owner: OWNER, signers: [SIGNER] };
const ORIGIN = 'https://claim.example';

const env: Env = {
  NETWORK: 'testnet', CONTRACT_ID: 'zarf-near-1112.testnet', NEAR_RPC_URL: 'https://rpc.example', EXPECTED_OWNER: OWNER,
  EXPECTED_SIGNERS: SIGNER, CLAIM_PAGE_URL: `${ORIGIN}/claim/1/0`, ALERT_WEBHOOK_URL: 'https://hooks.example/x',
};

/** A fetcher answering the RPC with `watch` and the claim origin with one site variant. */
const world = (watch: unknown, v: Variant, owner = OWNER) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url === env.NEAR_RPC_URL) return viewResponse(JSON.parse(String(init!.body)).params.method_name === 'watch' ? watch : owner);
    return siteResponse(v, new URL(url).pathname);
  });
const site = (v: Variant) => (url: string) => Promise.resolve(siteResponse(v, new URL(url).pathname));

describe('watch(): recorded outputs', () => {
  it('no change: nothing to report', () => {
    expect(contractFindings(clean as WatchView, OWNER, ex)).toEqual([]);
  });
  it('proposed upgrade: one finding with the code hash and when it can be applied', () => {
    expect(contractFindings(proposed as WatchView, OWNER, ex)).toEqual([
      'UPGRADE PROPOSED: code sha256 3f703dd7808b25b990dd8623f3603b47a5325ec139e5186344da00f308493bd5, source "github.com/example/zarf@abc1234 (contract 0.1.2)", can be applied from 2026-11-11T22:22:32.196Z',
    ]);
  });
  it('cancelled: back to nothing', () => {
    expect(contractFindings(cancelled as WatchView, OWNER, ex)).toEqual([]);
  });
  it('owner change proposed or done, verifier key added or removed', () => {
    const w = { ...clean, pending_owner: { new_owner: 'eve.testnet', ready_at_ns: '1794435752196081943' }, owner_keys: [{ signer: 'ee'.repeat(32), active_from_ns: '1794435752196081943', valid_until_ns: '0' }] };
    expect(contractFindings(w as WatchView, 'eve.testnet', ex)).toEqual([
      'OWNER CHANGE PROPOSED: eve.testnet, can be accepted from 2026-11-11T22:22:32.196Z',
      `OWNER CHANGED: eve.testnet (expected ${OWNER})`,
      `VERIFIER KEY ADDED: ${'ee'.repeat(32)}, signs from 2026-11-11T22:22:32.196Z`,
      `VERIFIER KEY REMOVED: ${SIGNER}`,
    ]);
  });
});

describe('claim page fingerprint: bundle fixtures', () => {
  it('ignores the per-request nonce and follows static and dynamic imports', async () => {
    const fp = await fingerprint(`${ORIGIN}/claim/1/0`, site('same'), 44);
    expect(fp).toEqual(await fingerprint(`${ORIGIN}/claim/1/0`, site('same'), 44)); // two fetches, two nonces
    expect(Object.keys(fp.scripts)).toEqual([
      '/_app/immutable/chunks/c.C1.js', '/_app/immutable/entry/app.B1.js', '/_app/immutable/entry/start.A1.js', '/_app/immutable/nodes/0.D1.js',
    ]);
    expect(fp).toEqual(expectedLocal); // the local wrangler run's expected list is this fixture's
  });
  it('same: nothing to report', async () => {
    expect(bundleFindings(await fingerprint(`${ORIGIN}/claim/1/0`, site('same'), 44), expectedLocal)).toEqual([]);
  });
  it('changed script: reported by path', async () => {
    expect(bundleFindings(await fingerprint(`${ORIGIN}/claim/1/0`, site('changed'), 44), expectedLocal)).toEqual(['SCRIPT CHANGED: /_app/immutable/chunks/c.C1.js']);
  });
  it('extra script: reported, with the importer that changed to load it', async () => {
    expect(bundleFindings(await fingerprint(`${ORIGIN}/claim/1/0`, site('extra'), 44), expectedLocal)).toEqual([
      'SCRIPT ADDED: /_app/immutable/chunks/x.E1.js', 'SCRIPT CHANGED: /_app/immutable/nodes/0.D1.js',
    ]);
  });
  it('more scripts than the subrequest budget is an alert, not a partial pass', async () => {
    await expect(fingerprint(`${ORIGIN}/claim/1/0`, site('same'), 3)).rejects.toThrow('more than 3 scripts');
  });
  it('only same-origin .js references count', () => {
    expect(scriptRefs('import("./a.js");x="https://cdn.example/b.js";y="../c.js";z="d.css"', `${ORIGIN}/_app/immutable/entry/s.js`)).toEqual([
      '/_app/immutable/entry/a.js', '/_app/immutable/c.js',
    ]);
    expect(normalizeHtml('<script nonce="abc==">')).toBe('<script>');
  });
  it('the testnet expected list is recorded and mainnet has none yet', () => {
    expect(Object.keys(EXPECTED.testnet!.scripts).length).toBeGreaterThan(0);
    expect(EXPECTED.mainnet).toBeNull();
    expect(bundleFindings(expectedLocal, null)[0]).toMatch(/^NO EXPECTED FINGERPRINT/);
  });
});

describe('run + alert', () => {
  it('clean contract and same bundle: nothing', async () => {
    expect(await run(env, expectedLocal, world(clean, 'same'))).toEqual([]);
  });
  it('proposed upgrade and a changed script land in one alert', async () => {
    const f = await run(env, expectedLocal, world(proposed, 'changed'));
    expect(f).toHaveLength(2);
    const post = vi.fn(async (_u: string, _i?: RequestInit) => new Response('ok'));
    await alert(env, f, post);
    expect(post).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(post.mock.calls[0][1]!.body));
    expect(body.text).toBe(body.content);
    expect(body.text).toMatch(/^\[zarf-near testnet\] zarf-near-1112\.testnet .*\n- UPGRADE PROPOSED: .*\n- SCRIPT CHANGED: /);
  });
  it('a run that cannot read is an alert', async () => {
    const down = vi.fn(async () => { throw new Error('rpc down'); });
    expect(await run(env, expectedLocal, down)).toEqual([
      'CANNOT READ zarf-near-1112.testnet: rpc down', 'CANNOT CHECK THE CLAIM PAGE: rpc down',
    ]);
  });
  it('empty config is an alert; a missing webhook throws so the cron run shows failed', async () => {
    expect(await run({ ...env, CONTRACT_ID: '' }, expectedLocal, world(clean, 'same'))).toEqual(['WATCHER MISCONFIGURED: CONTRACT_ID empty, nothing was checked']);
    await expect(alert({ ...env, ALERT_WEBHOOK_URL: undefined }, ['x'], vi.fn())).rejects.toThrow('ALERT_WEBHOOK_URL is not set');
    await expect(alert(env, ['x'], async () => new Response('', { status: 500 }))).rejects.toThrow('HTTP 500');
  });
});
