// scripts/jsonc.cjs: every wrangler.jsonc the scripts read parses, for testnet and mainnet, and `//` inside a string
// ("https://…") is never taken for a comment. The old line-only strip (watcher-refresh.sh:16 before T-031) is kept
// here to show the case that broke the 14 Nov testnet release.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { readJsonc, stripJsonc } = require('./jsonc.cjs');
const root = new URL('..', import.meta.url).pathname;
const oldParse = (s) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, '')); // watcher-refresh.sh:16 before T-031

// The env.testnet line as it stood when the release stopped (watcher/wrangler.jsonc at d9dd223).
const BROKE = `{
  // a whole-line comment
  "env": { "testnet": { "vars": {
    "CLAIM_PAGE_URL": "https://near.zarf.to/claim/1/0", // what visitors load, through proxy/ (T-029)
    "SCRIPTS_PER_RUN": "40"
  } } }
}`;

test('the old strip fails on a trailing comment; the new one reads the value, https:// intact', () => {
  assert.throws(() => oldParse(BROKE), SyntaxError);
  assert.equal(JSON.parse(stripJsonc(BROKE)).env.testnet.vars.CLAIM_PAGE_URL, 'https://near.zarf.to/claim/1/0');
});

test('comments are removed only outside strings; escapes and block comments are handled', () => {
  const s = '{ "a": "x // not a comment", "b": "say \\"//\\" here", /* block\n comment */ "c": "/* kept */" } // end';
  assert.deepEqual(JSON.parse(stripJsonc(s)), { a: 'x // not a comment', b: 'say "//" here', c: '/* kept */' });
  assert.throws(() => stripJsonc('{ "a": 1 /* open'), /unterminated \/\* comment/);
  assert.throws(() => stripJsonc('{ "a": "open'), /unterminated string/);
});

test('an unparsable file is an error that names the file', () => {
  assert.throws(() => readJsonc(new URL('./jsonc.test.mjs', import.meta.url).pathname), /jsonc\.test\.mjs is not valid JSONC/);
});

test('every wrangler.jsonc the scripts read parses, with env.testnet and env.mainnet vars', () => {
  for (const w of ['watcher', 'verifier', 'relayer', 'web']) {
    const c = readJsonc(`${root}${w}/wrangler.jsonc`);
    for (const net of ['testnet', 'mainnet']) assert.equal(typeof c.env?.[net]?.vars, 'object', `${w} env.${net}.vars`);
  }
  for (const w of ['faucet', 'proxy']) assert.equal(typeof readJsonc(`${root}${w}/wrangler.jsonc`).name, 'string', w);
  // The values the scripts use: watcher-refresh.sh reads CLAIM_PAGE_URL, release-testnet.sh greps STARTER_NEAR.
  assert.equal(readJsonc(`${root}watcher/wrangler.jsonc`).env.testnet.vars.CLAIM_PAGE_URL, 'https://near.zarf.to/claim/1/0');
  assert.equal(readJsonc(`${root}relayer/wrangler.jsonc`).env.testnet.vars.STARTER_NEAR, 'on');
});

test('the CLI form watcher-refresh.sh uses prints the testnet claim page URL', () => {
  const out = execFileSync('node', ['scripts/jsonc.cjs', 'watcher/wrangler.jsonc', 'env.testnet.vars.CLAIM_PAGE_URL'], { cwd: root, encoding: 'utf8' });
  assert.equal(out.trim(), 'https://near.zarf.to/claim/1/0');
  assert.equal(execFileSync('node', ['scripts/jsonc.cjs', 'watcher/wrangler.jsonc', 'env.nope.vars.X'], { cwd: root, encoding: 'utf8' }).trim(), '');
});

test('no script still parses wrangler.jsonc with the line-only strip', () => {
  for (const f of ['watcher-refresh.sh', 'deploy-mainnet-hosting.sh', 'release-testnet.sh', 'enable-google-testnet.sh'])
    assert.doesNotMatch(readFileSync(`${root}scripts/${f}`, 'utf8'), /replace\(\/\^\\s\*\\\/\\\//, f);
});
