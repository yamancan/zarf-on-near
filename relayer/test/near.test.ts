import { KeyPair, KeyPairEd25519, PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction, Signature, SignedTransaction } from '@near-js/transactions';
import { describe, expect, it } from 'vitest';
import vectors from '../../spec/vectors.json';
import { base58Decode, base58Encode, encodeTx, isNearSecretKey, parseNearKey, signTx } from '../src/near';

// A throwaway key built from the spec's test seed: seed || pub, as NEAR CLI writes it.
const unhex = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
const SECRET = `ed25519:${base58Encode(unhex(vectors.keys.signer_seed + vectors.keys.signer))}`;
const args = new TextEncoder().encode(JSON.stringify(vectors.claims.valid[0].call_args));
const blockHash = unhex('11'.repeat(32));

describe('base58', () => {
  it('round-trips, keeping leading zeros', () => {
    for (const b of [Uint8Array.of(0, 0, 1), unhex(vectors.keys.signer), new Uint8Array(32)]) expect(base58Decode(base58Encode(b))).toEqual(b);
    expect(base58Encode(new TextEncoder().encode('Hello World!'))).toBe('2NEpo7TZRRrLZSi2U');
  });
  it('rejects characters outside the alphabet', () => expect(() => base58Decode('0OIl')).toThrow());
});

describe('transaction encoding (oracle: @near-js/transactions)', () => {
  it('borsh(Transaction) and borsh(SignedTransaction) match byte for byte', async () => {
    const key = await parseNearKey(SECRET);
    const tx = { signerId: 'relayer.testnet', publicKey: key.publicKey, nonce: 123456789012n, receiverId: 'zarf-near.testnet', blockHash, methodName: 'claim', args, gas: 150_000_000_000_000n };

    const ref = createTransaction('relayer.testnet', PublicKey.fromString(key.publicKeyStr), 'zarf-near.testnet', 123456789012n,
      [actionCreators.functionCall('claim', args, 150_000_000_000_000n, 0n)], blockHash);
    expect(encodeTx(tx)).toEqual(encodeTransaction(ref));

    const ours = await signTx(key.key, tx);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(encodeTransaction(ref))));
    const refSig = (KeyPair.fromString(SECRET as `ed25519:${string}`) as KeyPairEd25519).sign(digest).signature;
    const refSigned = new SignedTransaction({ transaction: ref, signature: new Signature({ keyType: 0, data: refSig }) }).encode();
    expect(ours.signed).toEqual(new Uint8Array(refSigned));
    expect(ours.hash).toBe(base58Encode(digest));
  });
});

describe('isNearSecretKey (the RELAYER_MISCONFIGURED gate)', () => {
  it('accepts ed25519:<base58 of 64 bytes>', () => expect(isNearSecretKey(SECRET)).toBe(true));
  it.each([
    ['undefined', undefined], ['empty', ''], ['no prefix', SECRET.slice(8)], ['secp256k1 prefix', `secp256k1:${SECRET.slice(8)}`],
    ['32 bytes', `ed25519:${base58Encode(unhex(vectors.keys.signer_seed))}`], ['65 bytes', `ed25519:${base58Encode(unhex(vectors.keys.signer_seed + vectors.keys.signer + '00'))}`],
    ['non-base58 characters', `ed25519:${SECRET.slice(8, -1)}0`],
  ])('rejects %s', (_, s) => expect(isNearSecretKey(s)).toBe(false));
});

describe('parseNearKey', () => {
  it('reads the NEAR key format and derives the public key', async () => {
    expect((await parseNearKey(SECRET)).publicKeyStr).toBe(`ed25519:${base58Encode(unhex(vectors.keys.signer))}`);
  });
  it.each([
    ['no prefix', SECRET.slice(8)],
    ['wrong length', `ed25519:${base58Encode(unhex(vectors.keys.signer_seed))}`],
    ['public half from another key', `ed25519:${base58Encode(unhex(vectors.keys.signer_seed + vectors.keys.rogue_signer))}`],
  ])('rejects %s', async (_, s) => {
    await expect(parseNearKey(s)).rejects.toThrow();
  });
});
