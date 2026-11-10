#!/usr/bin/env node
// Generates the two fresh mainnet secrets, once, at deploy time (docs/deploy/mainnet-hosting.md):
//   <dir>/mainnet-verifier.seed  64 lowercase hex: the verifier's ed25519 seed (Mode W owner key)
//   <dir>/mainnet-relayer.key    ed25519:<base58 of seed||public>: the relayer's function-call key
// <dir> is $ZARF_NEAR_SECRETS or ~/.config/zarf-near. Files are mode 600 and never overwritten.
// Prints only public facts: the verifier signer (hex) and the relayer public key (ed25519:...).
// Never reuses the testnet or spec test keys; the contract refuses test keys on mainnet anyway.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes) {
  let n = BigInt('0x' + (Buffer.from(bytes).toString('hex') || '0'));
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const publicOf = (seed) =>
  createPublicKey(createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' }).subarray(-32);

function freshSeed() {
  const { privateKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  // Self-check: the seed re-imports to a key that signs, and the derived public half verifies it.
  const msg = Buffer.from('zarf-near mainnet key check');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8, seed]), format: 'der', type: 'pkcs8' });
  if (!verify(null, msg, createPublicKey(key), sign(null, msg, key))) throw new Error('key self-check failed');
  return seed;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.env.ZARF_NEAR_SECRETS || join(homedir(), '.config', 'zarf-near');
  const seedFile = join(dir, 'mainnet-verifier.seed');
  const keyFile = join(dir, 'mainnet-relayer.key');
  for (const f of [seedFile, keyFile]) if (existsSync(f)) throw new Error(`${f} exists; refusing to overwrite a mainnet secret`);
  const spec = JSON.parse(readFileSync(new URL('../spec/vectors.json', import.meta.url), 'utf8'));

  const vSeed = freshSeed();
  const rSeed = freshSeed();
  if (vSeed.toString('hex') === spec.keys.signer_seed) throw new Error('generated the spec test seed'); // cannot happen; cheap to check
  const rPub = publicOf(rSeed);

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(seedFile, vSeed.toString('hex') + '\n', { mode: 0o600, flag: 'wx' });
  writeFileSync(keyFile, `ed25519:${base58(Buffer.concat([rSeed, rPub]))}\n`, { mode: 0o600, flag: 'wx' });
  console.log(`wrote ${seedFile} and ${keyFile} (mode 600)`);
  console.log(`verifier signer (public, for add_owner_key and VERIFIER_SIGNERS): ${publicOf(vSeed).toString('hex')}`);
  console.log(`relayer public key (for the function-call access key): ed25519:${base58(rPub)}`);
}
