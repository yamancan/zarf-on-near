import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./demo.mjs', import.meta.url));
const run = (args, env) => spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8', timeout: 60_000 });

test('DEMO_REQUIRE_RPC=1 never falls back to --dry', () => {
  for (const args of [['--dry'], []]) {
    const r = run(args, { DEMO_REQUIRE_RPC: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /DEMO FAILED: sandbox exports missing/);
    assert.doesNotMatch(r.stdout, /DEMO PASSED/);
  }
});

test('without --dry and without the sandbox exports it fails, naming what is missing', () => {
  const r = run([], {});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /set NEAR_RPC_URL/);
});
