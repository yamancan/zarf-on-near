// Generates spec/vectors.json from fixed inputs (spec/claim.md v2) and self-checks it.
// Run: node spec/gen-vectors.mjs   (zero dependencies, Node >= 20)
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => { const v = BigInt(n); return Buffer.concat([u64(v & 0xffffffffffffffffn), u64(v >> 64n)]); };
const str = (s) => { const b = Buffer.from(s, 'ascii'); assert(b.length <= 255); return Buffer.concat([Buffer.from([b.length]), b]); };

// Raw 32-byte seed → Node Ed25519 key via the fixed PKCS8 prefix.
const edPriv = (seed) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
const rawPub = (k) => crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32);
const edPub = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });

export function canonicalEmail(e) {
  const t = e.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!/^[\x21-\x7e]+$/.test(t)) throw new Error('email must be ASCII'); // before lowercasing: U+212A lowercases to ASCII 'k'
  return t.toLowerCase();
}
export const commitment = (salt, email) => crypto.createHmac('sha256', salt).update(canonicalEmail(email), 'ascii').digest();
export const leafHash = (c, amount) => sha256(Buffer.from([0]), c, u128(amount));
export const nodeHash = (a, b) => (Buffer.compare(a, b) <= 0 ? sha256(Buffer.from([1]), a, b) : sha256(Buffer.from([1]), b, a));

export function buildTree(leaves) {
  assert(leaves.length >= 1);
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const cur = levels.at(-1), next = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]);
    levels.push(next);
  }
  return levels;
}
export function proofFor(levels, index) {
  const proof = [];
  for (const level of levels.slice(0, -1)) {
    const sib = index ^ 1;
    if (sib < level.length) proof.push(level[sib]); // odd tail is carried up: no sibling
    index >>= 1;
  }
  return proof;
}
export const verifyProof = (leaf, proof, root) => proof.reduce(nodeHash, leaf).equals(root);
export const nonce = (destination) => hex(sha256(Buffer.from(destination, 'ascii')));
export const payload = (p) => Buffer.concat([
  Buffer.from('ZARF-NEAR-CLAIM-V1', 'ascii'), str(p.network), str(p.contract_id), u64(p.campaign_id),
  Buffer.from(p.commitment, 'hex'), u128(p.amount), str(p.destination), u64(p.expires_at_ns),
]);

// ---- fixed inputs (test-only keys and salts; never use outside vectors) ----
const fill = (b, n = 32) => Buffer.alloc(n, b);
const signerKey = edPriv(fill(1)), rogueKey = edPriv(fill(9));
const signer = hex(rawPub(signerKey)), rogue = hex(rawPub(rogueKey));

const NOW_NS = 1794484800n * 1_000_000_000n; // 2026-11-12T12:00:00Z
const MIN = 60n * 1_000_000_000n;
const context = {
  network: 'testnet', contract_id: 'zarf-near.testnet',
  now_ns: String(NOW_NS), min_lifetime_ns: String(10n * MIN),
  deadline_ns: String(NOW_NS + 60n * MIN), expires_at_ns: String(NOW_NS + 10n * MIN),
};

function campaign(id, rows) {
  const recipients = rows.map((r, i) => {
    const salt = fill(0x10 + id * 16 + i);
    const c = commitment(salt, r.email);
    return { email: r.email, canonical_email: canonicalEmail(r.email), salt: hex(salt), amount: r.amount, commitment: hex(c), leaf: hex(leafHash(c, r.amount)) };
  });
  const levels = buildTree(recipients.map((r) => Buffer.from(r.leaf, 'hex')));
  return { campaign_id: String(id), merkle_root: hex(levels.at(-1)[0]), recipients, levels };
}
const main = campaign(7, [
  { email: 'alice@example.com', amount: '10000000' },
  { email: '  Bob.Smith@Gmail.com\r\n', amount: '2500000' },
  { email: 'carol+tag@example.org', amount: '1' },
  { email: 'dave@example.net', amount: '340282366920938463463374607431768211455' }, // u128::MAX encoding
  { email: 'alice@example.com', amount: '42' }, // duplicate email, own salt; 5 leaves exercise the odd tail
]);
const single = campaign(8, [{ email: 'solo@example.com', amount: '5000000' }]);

function claim(c, i, destination, { args = {}, signed = {}, key = signerKey } = {}) {
  const r = c.recipients[i];
  const call_args = {
    campaign_id: c.campaign_id, commitment: r.commitment, amount: r.amount,
    proof: proofFor(c.levels, i).map(hex), destination, expires_at_ns: context.expires_at_ns,
    signer: hex(rawPub(key)), ...args,
  };
  const ctx = { network: context.network, contract_id: context.contract_id };
  const rebuilt = payload({ ...ctx, ...call_args });
  call_args.signature = hex(crypto.sign(null, payload({ ...ctx, ...call_args, ...signed }), key));
  return { call_args, payload: hex(rebuilt), nonce: nonce(destination) };
}

const valid = [
  { name: 'named-account', campaign: 'main', ...claim(main, 0, 'alice.testnet') },
  { name: 'implicit-account', campaign: 'main', ...claim(main, 1, 'a'.repeat(64)) },
  { name: 'carried-up-tail', campaign: 'main', ...claim(main, 4, 'alice.testnet') },
  { name: 'single-leaf-empty-proof', campaign: 'single', ...claim(single, 0, 'solo.testnet') },
];
const sigBad = (name, opts) => ({ name, campaign: 'main', expect: 'E101_INVALID_SIGNATURE', ...claim(main, 0, 'alice.testnet', opts) });
const invalid = [
  sigBad('amount-differs-from-signed', { signed: { amount: '10000001' } }),
  sigBad('destination-differs-from-signed', { signed: { destination: 'mallory.testnet' } }),
  sigBad('campaign-differs-from-signed', { signed: { campaign_id: '6' } }),
  sigBad('expiry-differs-from-signed', { signed: { expires_at_ns: String(NOW_NS + 11n * MIN) } }),
  sigBad('signed-for-other-contract', { signed: { contract_id: 'evil.testnet' } }),
  sigBad('signed-for-mainnet', { signed: { network: 'mainnet' } }),
  sigBad('signer-not-registered', { key: rogueKey }),
  sigBad('signer-field-swapped', { args: { signer: rogue } }),
  { name: 'amount-not-in-tree', campaign: 'main', expect: 'E102_INVALID_MERKLE_PROOF', ...claim(main, 0, 'alice.testnet', { args: { amount: '99' } }) },
  { name: 'proof-of-other-leaf', campaign: 'main', expect: 'E102_INVALID_MERKLE_PROOF', ...claim(main, 0, 'alice.testnet', { args: { proof: proofFor(main.levels, 2).map(hex) } }) },
];

const pub = ({ levels, ...c }) => c;
const out = {
  spec: 'spec/claim.md v2',
  keys: { signer_seed: hex(fill(1)), signer, rogue_signer: rogue, registered: [signer] },
  context,
  campaigns: { main: pub(main), single: pub(single) },
  claims: { valid, invalid },
  rejected_emails: ['﻿alice@example.com', 'josé@example.com', '\u212a@example.com', 'a b@example.com', '   '],
};

// ---- self-check: every vector must verify (or fail) exactly the way it claims ----
const roots = { main: Buffer.from(main.merkle_root, 'hex'), single: Buffer.from(single.merkle_root, 'hex') };
const sigOk = (c) => c.call_args.signer === signer
  && crypto.verify(null, Buffer.from(c.payload, 'hex'), edPub(Buffer.from(signer, 'hex')), Buffer.from(c.call_args.signature, 'hex'));
const treeOk = (c) => verifyProof(leafHash(Buffer.from(c.call_args.commitment, 'hex'), c.call_args.amount), c.call_args.proof.map((h) => Buffer.from(h, 'hex')), roots[c.campaign]);
assert.equal(main.recipients.length, 5);
assert.equal(main.recipients[1].canonical_email, 'bob.smith@gmail.com');
assert.notEqual(main.recipients[0].commitment, main.recipients[4].commitment);
assert.equal(single.merkle_root, single.recipients[0].leaf);
assert.equal(valid[3].call_args.proof.length, 0);
for (const e of out.rejected_emails) assert.throws(() => canonicalEmail(e), e);
for (const c of valid) { assert(sigOk(c), c.name); assert(treeOk(c), c.name); assert.equal(c.nonce.length, 64); }
for (const c of invalid) assert(c.expect === 'E101_INVALID_SIGNATURE' ? !sigOk(c) && treeOk(c) : sigOk(c) && !treeOk(c), c.name);
assert(valid.length >= 4 && invalid.length >= 10);

writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`vectors.json v2: ${valid.length} valid, ${invalid.length} invalid, root ${main.merkle_root}`);
