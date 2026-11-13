// scripts/release-testnet.sh remember(): the live version id before a deploy becomes a rollback line; a Worker that
// does not exist yet (wrangler code 10007) becomes a commented delete line; any other failure stops the release.
// The script is sourced (functions only) with `npx` stubbed on PATH: no network, no Cloudflare, nothing deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = new URL('./release-testnet.sh', import.meta.url).pathname;

function remember(mode, args) {
  const dir = mkdtempSync(join(tmpdir(), 'zarf-release-'));
  mkdirSync(join(dir, 'bin'));
  for (const d of ['watcher', 'faucet']) mkdirSync(join(dir, d));
  writeFileSync(join(dir, 'token'), 'not-a-token');
  // The stub answers `wrangler deployments status` the way wrangler 4.160 does in each case.
  writeFileSync(join(dir, 'bin/npx'), `#!/bin/sh
case "$STUB" in
  live) echo '{"id":"d","versions":[{"version_id":"v-live","percentage":100}]}' ;;
  new) echo '✘ [ERROR] A request to the Cloudflare API failed.' >&2; echo '  This Worker does not exist on your account. [code: 10007]' >&2; exit 1 ;;
  split) echo '{"id":"d","versions":[{"version_id":"a","percentage":50},{"version_id":"b","percentage":50}]}' ;;
  *) echo '✘ [ERROR] Authentication error [code: 10000]' >&2; exit 1 ;;
esac
`);
  chmodSync(join(dir, 'bin/npx'), 0o755);
  const rollback = join(dir, 'rollback.txt');
  writeFileSync(rollback, '');
  const r = spawnSync('bash', ['-c', `source "${SCRIPT}" && cd "${dir}" && root="${dir}" && remember ${args}`], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, STUB: mode, ROLLBACK: rollback, CLOUDFLARE_TOKEN_FILE: join(dir, 'token'), DRY: '' },
  });
  return { status: r.status, out: r.stdout + r.stderr, lines: readFileSync(rollback, 'utf8'), dir };
}

test('a live Worker: one rollback line to the version that was live', () => {
  const r = remember('live', 'watcher zarf-near-watcher-testnet --env testnet');
  assert.equal(r.status, 0, r.out);
  assert.match(r.lines, /^\(cd \S+\/watcher && CLOUDFLARE_API_TOKEN=\$\(cat \S+\) npx wrangler rollback v-live --env testnet -m 'release-testnet rollback' -y\)  # zarf-near-watcher-testnet\n$/);
  assert.doesNotMatch(r.lines, /not-a-token/);
});

test('a Worker that does not exist yet (10007): a commented delete line, and the release goes on', () => {
  const r = remember('new', 'watcher zarf-near-watcher-testnet --env testnet');
  assert.equal(r.status, 0, r.out);
  assert.match(r.lines, /^# zarf-near-watcher-testnet was new before this release; to remove it: \(cd \S+\/watcher && CLOUDFLARE_API_TOKEN=\$\(cat \S+\) npx wrangler delete --env testnet --force\)\n$/);
  assert.match(r.out, /does not exist yet: this release creates it/);
});

test('the faucet (a temporary checkout) is addressed by name from web/, live or new', () => {
  const live = remember('live', '"$PWD/faucet" zarf-near-faucet-testnet');
  assert.equal(live.status, 0, live.out);
  assert.match(live.lines, /^\(cd \S+\/web && CLOUDFLARE_ACCOUNT_ID=f0b938c1641f5223c48199ec45751913 .* rollback v-live --name zarf-near-faucet-testnet /);
  const fresh = remember('new', '"$PWD/faucet" zarf-near-faucet-testnet');
  assert.match(fresh.lines, /^# zarf-near-faucet-testnet was new .*\(cd \S+\/web && .* delete --name zarf-near-faucet-testnet --force\)/);
});

test('any other failure stops (no line written), and so does a split rollout', () => {
  for (const mode of ['auth', 'split']) {
    const r = remember(mode, 'watcher zarf-near-watcher-testnet --env testnet');
    assert.notEqual(r.status, 0, `${mode}: ${r.out}`);
    assert.equal(r.lines, '', mode);
  }
});

test('the rerun hint (git reset --hard) is printed only once step 3 has begun; the first rollback file is kept', () => {
  const run = (setup) => spawnSync('bash', ['-c', `source "${SCRIPT}"; ${setup}; ROLLBACK=$(mktemp); echo line > "$ROLLBACK"; step=x; stopped`], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(run('rerun_hint='), /git reset --hard/);
  const late = run('rerun_hint=1');
  assert.match(late, /git reset --hard origin\/main/);
  assert.match(late, /Keep \S+: it holds the pre-release version ids/);
});
