import { describe, expect, it, vi } from 'vitest';
import { accountFindings, contractFindings, type WatchView } from '../src/contract.ts';
import { checkPage, fingerprint, normalizeHtml, pick, rotation, scriptRefs, type Fingerprint } from '../src/bundle.ts';
import { alert, EXPECTED, run, type Env } from '../src/index.ts';
import clean from './fixtures/watch-clean.json';
import proposed from './fixtures/watch-proposed.json';
import cancelled from './fixtures/watch-cancelled.json';
import expectedLocal from './local/expected.json';
import { CODE_HASH, KEYLESS, rpcResponse, siteResponse, type AccountFixture, type Variant } from './fixtures/site.ts';

const OWNER = 'zarf-near-owner-1111.testnet';
const SIGNER = '2d10ebec1ec795cef82b8d357cc60d39d9119b99908741660b632fc5cf0d4e32';
const ex = { owner: OWNER, signers: [SIGNER] };
const ORIGIN = 'https://claim.example';

const env: Env = {
  NETWORK: 'testnet', CONTRACT_ID: 'zarf-near-1112.testnet', NEAR_RPC_URL: 'https://rpc.example', EXPECTED_OWNER: OWNER,
  EXPECTED_SIGNERS: SIGNER, EXPECTED_CODE_HASH: CODE_HASH, CLAIM_PAGE_URL: `${ORIGIN}/claim/1/0`, ALERT_WEBHOOK_URL: 'https://hooks.example/x',
};

/** A fetcher answering the RPC with `watch` and the claim origin with one site variant. */
const world = (watch: unknown, v: Variant, owner = OWNER, account: AccountFixture = KEYLESS) =>
  vi.fn(async (url: string, init?: RequestInit) => {
    if (url === env.NEAR_RPC_URL) return rpcResponse(String(init!.body), { watch, get_owner: owner }, account);
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

const PAGE = `${ORIGIN}/claim/1/0`;
const EXP = expectedLocal as Fingerprint;

/** A page that loads `n` chunks (one per line of HTML), and counts every request. */
function bigSite(n: number) {
  const chunk = (i: number) => `/_app/immutable/chunks/k${i}.js`;
  const calls: string[] = [];
  const fetcher = async (url: string) => {
    const p = new URL(url).pathname;
    calls.push(p);
    if (p === '/claim/1/0') return new Response(Array.from({ length: n }, (_, i) => `<link rel="modulepreload" href="${chunk(i)}">`).join('\n'));
    const i = Number(/k(\d+)\.js$/.exec(p)?.[1] ?? NaN);
    return Number.isInteger(i) && i < n ? new Response(`export const v=${i};`) : new Response('nf', { status: 404 });
  };
  return { fetcher, calls };
}

describe('claim page fingerprint (deploy time): every script, any number', () => {
  it('ignores the per-request nonce and follows static and dynamic imports', async () => {
    const fp = await fingerprint(PAGE, site('same'));
    expect(fp).toEqual(await fingerprint(PAGE, site('same'))); // two fetches, two nonces
    expect(Object.keys(fp.scripts)).toEqual([
      '/_app/immutable/chunks/c.C1.js', '/_app/immutable/entry/app.B1.js', '/_app/immutable/entry/start.A1.js', '/_app/immutable/nodes/0.D1.js',
    ]);
    expect(fp).toEqual(expectedLocal); // the local wrangler run's expected list is this fixture's
  });
  it('records a page with 100 scripts (the free-plan cap of 44 no longer applies here)', async () => {
    expect(Object.keys((await fingerprint(PAGE, bigSite(100).fetcher)).scripts)).toHaveLength(100);
  });
  it('a runaway page is an error, never a partial list', async () => {
    await expect(fingerprint(PAGE, site('same'), 3)).rejects.toThrow('more than 3 scripts');
  });
  it('only same-origin .js references count', () => {
    expect(scriptRefs('import("./a.js");x="https://cdn.example/b.js";y="../c.js";z="d.css"', `${ORIGIN}/_app/immutable/entry/s.js`)).toEqual([
      '/_app/immutable/entry/a.js', '/_app/immutable/c.js',
    ]);
    expect(normalizeHtml('<script nonce="abc==">')).toBe('<script>');
  });
  it('the testnet expected list is recorded and mainnet has none yet', async () => {
    expect(Object.keys(EXPECTED.testnet!.scripts).length).toBeGreaterThan(0);
    expect(EXPECTED.mainnet).toBeNull();
    expect((await checkPage(PAGE, site('same'), null, 40, 0))[0]).toMatch(/^NO EXPECTED FINGERPRINT/);
  });
});

describe('claim page check (each cron run): HTML every run, scripts in rotation', () => {
  it('rotation: any ceil(n/perRun) consecutive runs cover every script, whatever the start', () => {
    for (let n = 1; n <= 60; n++) {
      const paths = Array.from({ length: n }, (_, i) => `p${String(i).padStart(2, '0')}`);
      for (const per of [1, 7, 40, 44]) {
        for (const start of [0, 5, 29_574_123]) {
          const seen = new Set<string>();
          for (let r = start; r < start + Math.ceil(n / per); r++) {
            const w = rotation(paths, per, r);
            expect(w.length).toBe(Math.min(n, per));
            w.forEach((p) => seen.add(p));
          }
          expect(seen.size).toBe(n);
        }
      }
    }
    expect(() => rotation(['a'], 0, 0)).toThrow('at least 1');
  });
  it('pick: 30 scheduled + 10 random of the rest; the scheduled slices alone cover all 47 in 2 runs', () => {
    const paths = Array.from({ length: 47 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    for (const r of [0, 1, 1234]) {
      const w = pick(paths, 40, r);
      expect(new Set(w).size).toBe(40);
      expect(w.slice(0, 30)).toEqual(rotation(paths, 30, r));
    }
    expect(new Set([...rotation(paths, 30, 8), ...rotation(paths, 30, 9)]).size).toBe(47);
    expect(pick(paths.slice(0, 40), 40, 3)).toEqual(paths.slice(0, 40)); // all fit: all, every run
  });
  it('an origin that knows the schedule cannot rely on the skipped paths (Duo P1)', async () => {
    // Each slot it serves a tampered copy of one path outside that slot's scheduled slice; random picks find it.
    const rec = await fingerprint(PAGE, bigSite(47).fetcher);
    const paths = Object.keys(rec.scripts).sort();
    let caught = 0;
    for (let run = 0; run < 200; run++) {
      const sched = new Set(rotation(paths, 30, run));
      const target = paths.find((p) => !sched.has(p))!;
      const tampered = async (url: string) => (new URL(url).pathname === target ? new Response('steal()') : bigSite(47).fetcher(url));
      if ((await checkPage(PAGE, tampered, rec, 40, run)).includes(`SCRIPT CHANGED: ${target}`)) caught++;
    }
    expect(caught).toBeGreaterThan(80); // 10 of the 17 unscheduled per run: ~59%; the old rotation caught 0
  });
  it('a redirect is not followed and is reported (each hop would cost a subrequest)', async () => {
    const moved = async (url: string) => (url.endsWith('/c.C1.js') ? new Response(null, { status: 302, headers: { location: '/x' } }) : siteResponse('same', new URL(url).pathname));
    expect(await checkPage(PAGE, moved, EXP, 40, 0)).toEqual(['SCRIPT NOT SERVED: /_app/immutable/chunks/c.C1.js (HTTP 302)']);
  });
  it('a 100-script page stays inside the free-plan budget: the page and 40 scripts per run', async () => {
    const big = bigSite(100);
    const rec = await fingerprint(PAGE, big.fetcher);
    big.calls.length = 0;
    expect(await checkPage(PAGE, big.fetcher, rec, 40, 7)).toEqual([]);
    expect(big.calls).toHaveLength(41);
  });
  it('same: nothing to report, in every run', async () => {
    for (const r of [0, 1, 2, 3]) expect(await checkPage(PAGE, site('same'), EXP, 1, r)).toEqual([]);
  });
  it('changed script: reported in the run that re-hashes it, at the latest within ceil(n/perRun) runs', async () => {
    expect(await checkPage(PAGE, site('changed'), EXP, 40, 0)).toEqual(['SCRIPT CHANGED: /_app/immutable/chunks/c.C1.js']);
    const hits: string[][] = [];
    for (const r of [0, 1, 2, 3]) hits.push(await checkPage(PAGE, site('changed'), EXP, 1, r));
    expect(hits.flat()).toEqual(['SCRIPT CHANGED: /_app/immutable/chunks/c.C1.js']);
  });
  it('extra script: the changed importer and the new file it names', async () => {
    expect(await checkPage(PAGE, site('extra'), EXP, 40, 0)).toEqual([
      'SCRIPT CHANGED: /_app/immutable/nodes/0.D1.js', 'SCRIPT ADDED: /_app/immutable/chunks/x.E1.js (imported by /_app/immutable/nodes/0.D1.js)',
    ]);
  });
  it('a changed page is reported every run, with any unrecorded script it names', async () => {
    const swapped = async (url: string) => {
      const r = siteResponse('same', new URL(url).pathname);
      return new URL(url).pathname === '/claim/1/0' ? new Response((await r.text()) + '<script type="module" src="/_app/evil.js"></script>') : r;
    };
    expect(await checkPage(PAGE, swapped, EXP, 1, 2)).toEqual(['CLAIM PAGE HTML CHANGED: /claim/1/0', 'SCRIPT ADDED: /_app/evil.js (named by the page)']);
  });
  it('a recorded script that is no longer served is reported', async () => {
    const gone = async (url: string) => (url.endsWith('/c.C1.js') ? new Response('nf', { status: 404 }) : siteResponse('same', new URL(url).pathname));
    expect(await checkPage(PAGE, gone, EXP, 40, 0)).toEqual(['SCRIPT NOT SERVED: /_app/immutable/chunks/c.C1.js (HTTP 404)']);
  });
});

describe('the escrow account itself (view_account, view_access_key_list)', () => {
  it('expected code hash and no keys: nothing', () => {
    expect(accountFindings(KEYLESS, CODE_HASH)).toEqual([]);
  });
  it('a different code hash pages, even when watch() looks clean', async () => {
    expect(accountFindings({ ...KEYLESS, code_hash: '11111111111111111111111111111111' }, CODE_HASH)).toEqual([`CODE HASH CHANGED: 11111111111111111111111111111111 (expected ${CODE_HASH})`]);
    expect(await run(env, EXP, world(clean, 'same', OWNER, { ...KEYLESS, code_hash: 'Hx' }))).toEqual([`CODE HASH CHANGED: Hx (expected ${CODE_HASH})`]);
  });
  it('any access key pages, full access or function call', () => {
    const keys = [
      { public_key: 'ed25519:AAA', access_key: { nonce: 1, permission: 'FullAccess' } },
      { public_key: 'ed25519:BBB', access_key: { nonce: 1, permission: { FunctionCall: { allowance: null, receiver_id: 'x', method_names: [] } } } },
    ];
    expect(accountFindings({ ...KEYLESS, keys }, CODE_HASH)).toEqual(['ACCESS KEY ON THE ESCROW: ed25519:AAA (full access)', 'ACCESS KEY ON THE ESCROW: ed25519:BBB (function call)']);
  });
});

describe('run + alert', () => {
  it('clean contract, keyless account with the expected code and same bundle: nothing, in 9 requests', async () => {
    const w = world(clean, 'same');
    expect(await run(env, EXP, w)).toEqual([]);
    expect(w).toHaveBeenCalledTimes(4 + 1 + 4); // watch, get_owner, view_account, access keys; the page; its 4 recorded scripts
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
  it('SCRIPTS_PER_RUN above the free-plan budget pages and is held at 40', async () => {
    for (const v of ['41', '0', 'x']) {
      expect(await run({ ...env, SCRIPTS_PER_RUN: v }, EXP, world(clean, 'same'))).toEqual([
        `WATCHER MISCONFIGURED: SCRIPTS_PER_RUN ${v} is not 1-40 (the free plan's budget); checked 40`,
      ]);
    }
  });
  it('a run that cannot read is an alert', async () => {
    const down = vi.fn(async () => { throw new Error('rpc down'); });
    expect(await run(env, expectedLocal, down)).toEqual([
      'CANNOT READ zarf-near-1112.testnet: rpc down', 'CANNOT READ THE ACCOUNT zarf-near-1112.testnet: rpc down', 'CANNOT CHECK THE CLAIM PAGE: rpc down',
    ]);
  });
  it('empty config is an alert; a missing webhook throws so the cron run shows failed', async () => {
    expect(await run({ ...env, CONTRACT_ID: '' }, expectedLocal, world(clean, 'same'))).toEqual(['WATCHER MISCONFIGURED: CONTRACT_ID empty, nothing was checked']);
    await expect(alert({ ...env, ALERT_WEBHOOK_URL: undefined }, ['x'], vi.fn())).rejects.toThrow('ALERT_WEBHOOK_URL is not set');
    await expect(alert(env, ['x'], async () => new Response('', { status: 500 }))).rejects.toThrow('HTTP 500');
  });
});
