import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { base58 } from './mainnet-keys.mjs';

const run = (dir) => execFileSync(process.execPath, [new URL('./mainnet-keys.mjs', import.meta.url).pathname], { env: { ...process.env, ZARF_NEAR_SECRETS: dir }, encoding: 'utf8' });

test('base58 keeps leading zero bytes as 1s', () => {
  assert.equal(base58(Buffer.from([0, 0, 1])), '112');
  assert.equal(base58(Buffer.from('ff', 'hex')), '5Q');
});

test('writes two fresh mode-600 secrets in the formats the workers parse, prints only public parts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zarf-keys-'));
  const out = run(dir);
  const seed = readFileSync(join(dir, 'mainnet-verifier.seed'), 'utf8').trim();
  const key = readFileSync(join(dir, 'mainnet-relayer.key'), 'utf8').trim();
  assert.match(seed, /^[0-9a-f]{64}$/); // verifier: SIGNER_SEED
  assert.match(key, /^ed25519:[1-9A-HJ-NP-Za-km-z]{80,90}$/); // relayer: isNearSecretKey
  for (const f of ['mainnet-verifier.seed', 'mainnet-relayer.key']) assert.equal(statSync(join(dir, f)).mode & 0o777, 0o600);
  assert.ok(!out.includes(seed) && !out.includes(key), 'no secret on stdout');
  assert.match(out, /verifier signer \(public.*\): [0-9a-f]{64}\n/);
  assert.throws(() => run(dir), /refusing to overwrite/);
});
