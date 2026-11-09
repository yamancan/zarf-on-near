// NEAR transaction encoding (borsh) and signing for one FunctionCall with zero deposit.
// Tested byte for byte against @near-js/transactions; Web Crypto only at runtime.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) {
    if (b) break;
    out = '1' + out;
  }
  return out;
}

export function base58Decode(s: string): Uint8Array<ArrayBuffer> {
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  const out: number[] = [];
  for (; n > 0n; n >>= 8n) out.unshift(Number(n & 0xffn));
  for (const ch of s) {
    if (ch !== '1') break;
    out.unshift(0);
  }
  return Uint8Array.from(out);
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

const uintLe = (v: bigint, bytes: number) => {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
};
const bytesVec = (b: Uint8Array) => concat(uintLe(BigInt(b.length), 4), b);
const str = (s: string) => bytesVec(new TextEncoder().encode(s));

export interface FunctionCallTx {
  signerId: string;
  publicKey: Uint8Array; // ed25519, 32 bytes
  nonce: bigint;
  receiverId: string;
  blockHash: Uint8Array; // 32 bytes
  methodName: string;
  args: Uint8Array;
  gas: bigint;
}

/** borsh(Transaction) with one FunctionCall action. The deposit is always 0: there is no parameter for it. */
export const encodeTx = (t: FunctionCallTx): Uint8Array<ArrayBuffer> =>
  concat(
    str(t.signerId),
    Uint8Array.of(0), // KeyType::ED25519
    t.publicKey,
    uintLe(t.nonce, 8),
    str(t.receiverId),
    t.blockHash,
    uintLe(1n, 4), // one action
    Uint8Array.of(2), // Action::FunctionCall
    str(t.methodName),
    bytesVec(t.args),
    uintLe(t.gas, 8),
    uintLe(0n, 16), // deposit
  );

/** Shape check only (prefix, alphabet, 64 bytes); parseNearKey also checks the public half. */
export function isNearSecretKey(s: string | undefined): s is string {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{60,100})$/.exec(s ?? '');
  return !!m && base58Decode(m[1]).length === 64;
}

export interface NearKey {
  key: CryptoKey;
  publicKey: Uint8Array;
  publicKeyStr: string; // ed25519:<base58>
}

/** Parses a NEAR secret key `ed25519:<base58(seed || pub)>` and checks the public half matches the seed. */
export async function parseNearKey(secret: string): Promise<NearKey> {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(secret);
  const raw = m ? base58Decode(m[1]) : new Uint8Array();
  if (raw.length !== 64) throw new Error('relayer key must be ed25519:<base58 of 64 bytes>');
  const pkcs8 = concat(Uint8Array.from([0x30, 0x2e, 2, 1, 0, 0x30, 5, 6, 3, 0x2b, 0x65, 0x70, 4, 0x22, 4, 0x20]), raw.subarray(0, 32));
  const { x } = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']));
  const derived = Uint8Array.from(atob(x!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const publicKey = raw.slice(32);
  if (derived.some((b, i) => b !== publicKey[i])) throw new Error('relayer key: public half does not match the seed');
  return {
    key: await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', false, ['sign']),
    publicKey,
    publicKeyStr: `ed25519:${base58Encode(publicKey)}`,
  };
}

/** Signs sha256(borsh(tx)); returns borsh(SignedTransaction) and the transaction hash. */
export async function signTx(key: CryptoKey, tx: FunctionCallTx): Promise<{ signed: Uint8Array; hash: string }> {
  const encoded = encodeTx(tx);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoded));
  const signature = new Uint8Array(await crypto.subtle.sign('Ed25519', key, digest));
  return { signed: concat(encoded, Uint8Array.of(0), signature), hash: base58Encode(digest) };
}
