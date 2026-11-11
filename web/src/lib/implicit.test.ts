import { describe, expect, it } from 'vitest';
import vectors from '../../../spec/vectors.json';
import { base58, createImplicitAccount, implicitAccountFromSeed, keyFile } from './implicit';

const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));

describe('base58', () => {
  it('known answers', () => {
    expect(base58(new TextEncoder().encode('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
    expect(base58(Uint8Array.of(0, 0, 1))).toBe('112');
    expect(base58(new Uint8Array())).toBe('');
  });
});

describe('implicit account', () => {
  it('derives the account id from the ed25519 public key (spec test key)', async () => {
    const a = await implicitAccountFromSeed(unhex(vectors.keys.signer_seed));
    expect(a.accountId).toBe(vectors.keys.signer);
    expect(a.publicKey).toBe(`ed25519:${base58(unhex(vectors.keys.signer))}`);
    expect(a.privateKey).toBe(`ed25519:${base58(unhex(vectors.keys.signer_seed + vectors.keys.signer))}`);
    expect(JSON.parse(keyFile(a))).toEqual({ account_id: a.accountId, public_key: a.publicKey, private_key: a.privateKey });
  });
  it('creates a fresh 64-hex account each time', async () => {
    const [a, b] = await Promise.all([createImplicitAccount(), createImplicitAccount()]);
    expect(a.accountId).toMatch(/^[0-9a-f]{64}$/);
    expect(a.accountId).not.toBe(b.accountId);
  });
});
