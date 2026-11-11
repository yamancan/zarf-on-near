// Mutant-style tests for the --dry mock: a correctly signed claim tx passes; each tampering fails.
// Run: node --test scripts/
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign as edSign, createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { claimPayload, verifyClaimTx } from './mock-near-rpc.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } = await import(`${root}relayer/node_modules/@near-js/transactions/lib/esm/index.js`);
const { PublicKey } = await import(`${root}relayer/node_modules/@near-js/crypto/lib/esm/index.js`);
const vectors = JSON.parse(readFileSync(`${root}spec/vectors.json`, 'utf8'));

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (bytes) => { let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b); let o = ''; for (; n > 0n; n /= 58n) o = B58[Number(n % 58n)] + o; return o; };
const verifierKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.keys.signer_seed, 'hex')]), format: 'der', type: 'pkcs8' });
const relayer = generateKeyPairSync('ed25519');
const relayerPub = relayer.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const named = vectors.claims.valid.find((c) => c.name === 'named-account');
const ctx = { contractId: 'zarf-near.test.near', network: 'testnet', relayerPublicKey: relayerPub, verifierSigner: vectors.keys.signer, merkleRoot: vectors.campaigns.main.merkle_root };

/** A claim tx as the relayer builds it, with optional tampering. */
function claimTx({ args: argsOver = {}, signedArgs = {}, receiver = ctx.contractId, method = 'claim', deposit = 0n, key = relayer.privateKey, pub = relayerPub, flipSig = false } = {}) {
  const base = { ...named.call_args, expires_at_ns: '9'.repeat(18) };
  const signedOver = { ...base, ...signedArgs };
  const signature = edSign(null, claimPayload(ctx.network, ctx.contractId, signedOver), verifierKey).toString('hex');
  const args = { ...base, signature, ...argsOver };
  const tx = createTransaction('relayer.test.near', PublicKey.fromString(`ed25519:${b58(pub)}`), receiver, 1n,
    [actionCreators.functionCall(method, Buffer.from(JSON.stringify(args)), 150_000_000_000_000n, deposit)], new Uint8Array(32).fill(1));
  const sig = edSign(null, createHash('sha256').update(encodeTransaction(tx)).digest(), key);
  if (flipSig) sig[0] ^= 1;
  return Buffer.from(new SignedTransaction({ transaction: tx, signature: new Signature({ keyType: 0, data: sig }) }).encode()).toString('base64');
}

test('a correct claim tx passes', () => {
  assert.equal(verifyClaimTx(claimTx(), ctx).commitment, named.call_args.commitment);
});

const other = generateKeyPairSync('ed25519');
const mutants = [
  ['tx signature flipped', { flipSig: true }, /bad tx signature/],
  ['tx signed by another key', { key: other.privateKey }, /bad tx signature/],
  ['tx claims another relayer key', { pub: other.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32), key: other.privateKey }, /unexpected key/],
  ['another receiver', { receiver: 'evil.test.near' }, /not a single zero-deposit claim/],
  ['another method', { method: 'reclaim' }, /not a single zero-deposit claim/],
  ['a deposit', { deposit: 1n }, /not a single zero-deposit claim/],
  ['amount changed after the verifier signed', { args: { amount: '10000001' } }, /E101/],
  ['destination changed after the verifier signed', { args: { destination: 'mallory.testnet' } }, /E101/],
  ['an unregistered signer', { args: { signer: vectors.keys.rogue_signer } }, /unregistered signer/],
  ['a proof for another leaf', { args: { proof: vectors.claims.valid.find((c) => c.name === 'implicit-account').call_args.proof } }, /E102/],
  ['an amount not in the tree, honestly signed', { args: { amount: '99' }, signedArgs: { amount: '99' } }, /E102/],
];
for (const [name, mutation, error] of mutants) {
  test(`refuses: ${name}`, () => assert.throws(() => verifyClaimTx(claimTx(mutation), ctx), error));
}
