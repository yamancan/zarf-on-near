// Generates spec/vectors.json from fixed inputs (spec/claim.md v1) and self-checks it.
// Run: node spec/gen-vectors.mjs   (zero dependencies, Node >= 20)
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const hex = (b) => Buffer.from(b).toString('hex');
const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (n) => { const v = BigInt(n); return Buffer.concat([u64(v & 0xffffffffffffffffn), u64(v >> 64n)]); };
const str = (s) => { const b = Buffer.from(s, 'utf8'); assert(b.length <= 255); return Buffer.concat([Buffer.from([b.length]), b]); };

// Raw 32-byte seeds → Node keys via the fixed PKCS8 prefixes for Ed25519 / X25519.
const priv = (prefix, seed) => crypto.createPrivateKey({ key: Buffer.concat([Buffer.from(prefix, 'hex'), seed]), format: 'der', type: 'pkcs8' });
const edPriv = (seed) => priv('302e020100300506032b657004220420', seed);
const xPriv = (seed) => priv('302e020100300506032b656e04220420', seed);
const rawPub = (k) => crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32);
const xPubKey = (raw) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), raw]), format: 'der', type: 'spki' });

export const canonicalEmail = (e) => e.trim().toLowerCase();
export const commitment = (salt, email) => crypto.createHmac('sha256', salt).update(canonicalEmail(email), 'utf8').digest();
export const leafHash = (c, amount) => sha256(Buffer.from([0]), c, u128(amount));
export const nodeHash = (a, b) => (Buffer.compare(a, b) <= 0 ? sha256(Buffer.from([1]), a, b) : sha256(Buffer.from([1]), b, a));

export function buildTree(leaves) {
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

export const nonce = (destination) => hex(sha256(Buffer.from(destination, 'utf8')));
export const payload = (p) => Buffer.concat([
  Buffer.from('ZARF-NEAR-CLAIM-V1', 'ascii'), str(p.network), str(p.contract_id), u64(p.campaign_id),
  Buffer.from(p.commitment, 'hex'), u128(p.amount), str(p.destination), u64(p.expires_at_ns),
]);

function seal(salt, sealPubRaw, merkleRoot, ephSeed, iv) {
  const eph = xPriv(ephSeed), ephPub = rawPub(eph);
  const shared = crypto.diffieHellman({ privateKey: eph, publicKey: xPubKey(sealPubRaw) });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, sealPubRaw]), 'ZARF-NEAR-SALT-V1', 32));
  const c = crypto.createCipheriv('aes-256-gcm', key, iv); c.setAAD(merkleRoot);
  const ct = Buffer.concat([c.update(salt), c.final()]);
  return Buffer.concat([ephPub, iv, ct, c.getAuthTag()]);
}
function unseal(sealed, sealPriv, merkleRoot) {
  const ephPub = sealed.subarray(0, 32), iv = sealed.subarray(32, 44), ct = sealed.subarray(44, 76), tag = sealed.subarray(76);
  const shared = crypto.diffieHellman({ privateKey: sealPriv, publicKey: xPubKey(ephPub) });
  const key = Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, rawPub(sealPriv)]), 'ZARF-NEAR-SALT-V1', 32));
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv); d.setAAD(merkleRoot); d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

// ---- fixed inputs (test-only keys; never use outside vectors) ----
const fill = (b) => Buffer.alloc(32, b);
const verifierSeed = fill(1), sealSeed = fill(2), ephSeed = fill(3), iv = Buffer.alloc(12, 4), salt = fill(5);
const verifierKey = edPriv(verifierSeed), sealKey = xPriv(sealSeed);
const rogueKey = edPriv(fill(9));

const recipients = [
  { email: 'alice@example.com', amount: '10000000' },
  { email: '  Bob.Smith@Gmail.com ', amount: '2500000' },
  { email: 'carol+tag@example.org', amount: '1' },
  { email: 'dave@example.net', amount: '340282366920938463463374607431768211455' }, // u128::MAX encoding
  { email: 'erin@example.com', amount: '42' }, // 5 leaves: exercises the carried-up odd tail
];
const commitments = recipients.map((r) => commitment(salt, r.email));
const leaves = recipients.map((r, i) => leafHash(commitments[i], r.amount));
const levels = buildTree(leaves), root = levels.at(-1)[0];
const sealed = seal(salt, rawPub(sealKey), root, ephSeed, iv);

const base = { network: 'testnet', contract_id: 'zarf-near.testnet', campaign_id: '7', expires_at_ns: '1763150400000000000' };
const claimFor = (i, destination, overrides = {}, key = verifierKey) => {
  const p = { ...base, commitment: hex(commitments[i]), amount: recipients[i].amount, destination, ...overrides };
  const signed = { ...p, ...(overrides.signed ?? {}) };
  delete p.signed; delete signed.signed;
  return { args: p, payload: hex(payload(p)), signature: hex(crypto.sign(null, payload(signed), key)) };
};

const valid = [
  { name: 'named-account', ...claimFor(0, 'alice.testnet'), proof: proofFor(levels, 0).map(hex), nonce: nonce('alice.testnet') },
  { name: 'implicit-account', ...claimFor(1, 'a'.repeat(64)), proof: proofFor(levels, 1).map(hex), nonce: nonce('a'.repeat(64)) },
  { name: 'carried-up-tail', ...claimFor(4, 'erin.testnet'), proof: proofFor(levels, 4).map(hex), nonce: nonce('erin.testnet') },
];
const invalid = [
  { name: 'amount-differs-from-signed', expect: 'E101_INVALID_SIGNATURE', ...claimFor(0, 'alice.testnet', { signed: { amount: '10000001' } }), proof: proofFor(levels, 0).map(hex) },
  { name: 'signed-for-other-contract', expect: 'E101_INVALID_SIGNATURE', ...claimFor(0, 'alice.testnet', { signed: { contract_id: 'evil.testnet' } }), proof: proofFor(levels, 0).map(hex) },
  { name: 'signed-for-mainnet', expect: 'E101_INVALID_SIGNATURE', ...claimFor(0, 'alice.testnet', { signed: { network: 'mainnet' } }), proof: proofFor(levels, 0).map(hex) },
  { name: 'rogue-verifier-key', expect: 'E101_INVALID_SIGNATURE', ...claimFor(0, 'alice.testnet', {}, rogueKey), proof: proofFor(levels, 0).map(hex) },
  { name: 'amount-not-in-tree', expect: 'E102_INVALID_MERKLE_PROOF', ...claimFor(0, 'alice.testnet', { amount: '99' }), proof: proofFor(levels, 0).map(hex) },
  { name: 'proof-of-other-leaf', expect: 'E102_INVALID_MERKLE_PROOF', ...claimFor(0, 'alice.testnet'), proof: proofFor(levels, 2).map(hex) },
];

const out = {
  spec: 'spec/claim.md v1',
  keys: {
    verifier_seed: hex(verifierSeed), verifier_pubkey: hex(rawPub(verifierKey)),
    seal_seed: hex(sealSeed), seal_pubkey: hex(rawPub(sealKey)), rogue_pubkey: hex(rawPub(rogueKey)),
  },
  campaign: {
    salt: hex(salt), merkle_root: hex(root), seal_eph_seed: hex(ephSeed), seal_iv: hex(iv), sealed_salt: hex(sealed),
    recipients: recipients.map((r, i) => ({ email: r.email, canonical_email: canonicalEmail(r.email), amount: r.amount, commitment: hex(commitments[i]), leaf: hex(leaves[i]) })),
  },
  claims: { context: base, valid, invalid },
};

// ---- self-check: every vector must verify (or fail) the way it claims ----
assert.equal(levels[0].length, 5);
assert.deepEqual(unseal(sealed, sealKey, root), salt);
assert.throws(() => unseal(sealed, sealKey, fill(0)));
assert.equal(out.campaign.recipients[1].canonical_email, 'bob.smith@gmail.com');
const vk = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawPub(verifierKey)]), format: 'der', type: 'spki' });
const sigOk = (c) => crypto.verify(null, Buffer.from(c.payload, 'hex'), vk, Buffer.from(c.signature, 'hex'));
const treeOk = (c) => verifyProof(leafHash(Buffer.from(c.args.commitment, 'hex'), c.args.amount), c.proof.map((h) => Buffer.from(h, 'hex')), root);
for (const c of valid) { assert(sigOk(c), c.name); assert(treeOk(c), c.name); assert.equal(c.nonce.length, 64); }
for (const c of invalid) assert(c.expect === 'E101_INVALID_SIGNATURE' ? !sigOk(c) : sigOk(c) && !treeOk(c), c.name);

writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(`vectors.json: ${valid.length} valid, ${invalid.length} invalid claims, root ${hex(root)}`);
