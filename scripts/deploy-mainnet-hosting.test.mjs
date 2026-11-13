// scripts/deploy-mainnet-hosting.sh refuses before anything goes live when the mainnet watcher has no
// ALERT_WEBHOOK_URL (blue-team B1). Runs the real script in a throwaway git repo with `npx` and `pnpm`
// stubbed on PATH: no network, no Cloudflare, nothing deployed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ACCOUNT = 'f0b938c1641f5223c48199ec45751913';

function sandbox(secretList) {
  const dir = mkdtempSync(join(tmpdir(), 'zarf-hosting-'));
  for (const d of ['scripts', 'watcher', 'verifier', 'bin', 'secrets']) mkdirSync(join(dir, d));
  copyFileSync(new URL('./deploy-mainnet-hosting.sh', import.meta.url), join(dir, 'scripts/deploy-mainnet-hosting.sh'));
  writeFileSync(join(dir, 'token'), 'not-a-token');
  writeFileSync(join(dir, 'secrets/mainnet-verifier.seed'), 'dummy'); // presence only: the gate runs before they are read
  writeFileSync(join(dir, 'secrets/mainnet-relayer.key'), 'dummy');
  writeFileSync(join(dir, 'secrets.json'), secretList);
  // npx wrangler <args>: log the call, answer whoami and secret list, refuse anything else.
  writeFileSync(join(dir, 'bin/npx'), `#!/bin/sh
echo "$PWD: $*" >> "${dir}/calls.log"
case "$*" in
  "wrangler whoami") echo "Account ID ${ACCOUNT}" ;;
  "wrangler secret list --env mainnet") cat "${dir}/secrets.json" ;;
  *) echo "unexpected: $*" >&2; exit 9 ;;
esac
`);
  writeFileSync(join(dir, 'bin/pnpm'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(dir, 'bin/npx'), 0o755);
  chmodSync(join(dir, 'bin/pnpm'), 0o755);
  writeFileSync(join(dir, '.gitignore'), 'bin/\nsecrets/\ntoken\nsecrets.json\ncalls.log\n');
  const git = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'fixture');
  const r = spawnSync('bash', ['scripts/deploy-mainnet-hosting.sh'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, CLOUDFLARE_TOKEN_FILE: join(dir, 'token'), ZARF_NEAR_SECRETS: join(dir, 'secrets') },
  });
  let calls = '';
  try {
    calls = readFileSync(join(dir, 'calls.log'), 'utf8');
  } catch {}
  return { ...r, calls };
}

test('refuses without ALERT_WEBHOOK_URL on the mainnet watcher, before any deploy', () => {
  const r = sandbox('[]');
  console.log(r.stderr.trim());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mainnet watcher has no ALERT_WEBHOOK_URL secret/);
  assert.doesNotMatch(r.calls, /deploy|secret put/);
});

test('with the secret it passes this gate (and stops at the next one here: env.mainnet is empty)', () => {
  const r = sandbox('[{"name":"ALERT_WEBHOOK_URL","type":"secret_text"}]');
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stderr, /ALERT_WEBHOOK_URL/);
  assert.match(r.stderr, /env\.mainnet is not filled in/);
  assert.doesNotMatch(r.calls, /deploy|secret put/);
});

test('a lookalike secret name does not count', () => {
  const r = sandbox('[{"name":"ALERT_WEBHOOK_URL_OLD","type":"secret_text"}]');
  assert.match(r.stderr, /no ALERT_WEBHOOK_URL secret/);
});
