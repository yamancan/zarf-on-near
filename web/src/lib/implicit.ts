// In-browser NEAR implicit account: the account id is the hex of an ed25519 public key.

import { hex } from './claim';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58(bytes: Uint8Array): string {
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

export interface ImplicitAccount {
  accountId: string;
  publicKey: string; // ed25519:<base58 pub>
  privateKey: string; // ed25519:<base58 seed||pub>, the NEAR key-file format
}

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function implicitAccountFromSeed(seed: Uint8Array): Promise<ImplicitAccount> {
  const pkcs8 = new Uint8Array([...[0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, 'Ed25519', true, ['sign']);
  const pub = b64url((await crypto.subtle.exportKey('jwk', key)).x!);
  return {
    accountId: hex(pub),
    publicKey: `ed25519:${base58(pub)}`,
    privateKey: `ed25519:${base58(new Uint8Array([...seed, ...pub]))}`,
  };
}

export const createImplicitAccount = () => implicitAccountFromSeed(crypto.getRandomValues(new Uint8Array(32)));

/** NEAR CLI credentials file, so the key imports into a wallet. */
export const keyFile = (a: ImplicitAccount) =>
  JSON.stringify({ account_id: a.accountId, public_key: a.publicKey, private_key: a.privateKey }, null, 2);
