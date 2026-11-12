// "New account with Face ID" (testnet spike, T-021). A WebAuthn passkey's PRF output is fixed per
// credential and salt, so the account's ed25519 seed is derived from it on every unlock and never
// stored: seed = HKDF-SHA256(PRF output), account = the implicit account of that seed.
// Research: /tmp/zarf-work §3.

import { implicitAccountFromSeed, type ImplicitAccount } from './implicit';
import { nearView, postJson } from './services';

const enc = new TextEncoder();
/** The PRF input; changing it changes every account, so it is versioned and never edited. */
export const PRF_SALT = enc.encode('zarf-near/v1');
const HKDF_INFO = enc.encode('zarf-near passkey ed25519 seed v1');

/** Testnet only, and only with both flags on: an unaudited in-browser hot wallet. */
export const passkeyOffered = (network: string, implicitFlag: string | undefined, passkeyFlag: string | undefined) =>
  network === 'testnet' && implicitFlag === 'on' && passkeyFlag === 'on';

/** The PRF output's own bytes (a view keeps its offset and length); WebAuthn gives 32. */
const prfBytes = (prf: BufferSource): Uint8Array<ArrayBuffer> => {
  const b = ArrayBuffer.isView(prf) ? new Uint8Array(prf.buffer, prf.byteOffset, prf.byteLength) : new Uint8Array(prf);
  if (b.length !== 32) throw new Error('PRF_LENGTH');
  return new Uint8Array(b) as Uint8Array<ArrayBuffer>;
};

export async function seedFromPrf(prf: BufferSource): Promise<Uint8Array> {
  const ikm = await crypto.subtle.importKey('raw', prfBytes(prf), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: HKDF_INFO }, ikm, 256);
  return new Uint8Array(bits);
}

export const accountFromPrf = async (prf: BufferSource) => implicitAccountFromSeed(await seedFromPrf(prf));

type PrfResult = { enabled?: boolean; results?: { first?: BufferSource } };
const prfOf = (c: Credential | null) =>
  ((c as PublicKeyCredential | null)?.getClientExtensionResults() as { prf?: PrfResult } | undefined)?.prf;
const PRF_EXT = { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs;

/** One Face ID: the PRF output of a passkey for this site (the given one, or any the user picks). */
async function prfFromGet(credentialId?: ArrayBuffer): Promise<BufferSource | undefined> {
  const c = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      userVerification: 'required',
      ...(credentialId ? { allowCredentials: [{ type: 'public-key', id: credentialId }] } : {}),
      extensions: PRF_EXT,
    },
  });
  return prfOf(c)?.results?.first;
}

/**
 * Creates a passkey and the account derived from it. `prf: false` means this browser or authenticator
 * gave no PRF output: the account then comes from a random key, and the key file is the only way back.
 */
export async function createPasskeyAccount(rpName = 'Zarf'): Promise<{ account: ImplicitAccount; prf: boolean }> {
  const c = await navigator.credentials.create({
    publicKey: {
      rp: { name: rpName },
      // Random per account: reusing a user.id makes Apple and Google overwrite the earlier passkey.
      user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'Zarf NEAR account', displayName: 'Zarf NEAR account' },
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      extensions: PRF_EXT,
    },
  });
  if (!c) throw new Error('NO_CREDENTIAL');
  // Some authenticators enable PRF at create but evaluate it only on get (a second prompt).
  const prf = prfOf(c)?.results?.first ?? (prfOf(c)?.enabled ? await prfFromGet((c as PublicKeyCredential).rawId) : undefined);
  if (!prf) return { account: await implicitAccountFromSeed(crypto.getRandomValues(new Uint8Array(32))), prf: false };
  return { account: await accountFromPrf(prf), prf: true };
}

/** Face ID again: re-derives the account from whichever passkey the user picks. */
export async function unlockPasskeyAccount(): Promise<ImplicitAccount> {
  const prf = await prfFromGet();
  if (!prf) throw new Error('NO_PRF');
  return accountFromPrf(prf);
}

/** NEAR (yocto) and token (base units) balances. Only UNKNOWN_ACCOUNT means "no NEAR yet"; any other RPC error throws. */
export async function accountBalances(rpcUrl: string, tokenId: string, accountId: string): Promise<{ near: bigint; token: bigint }> {
  const res = await postJson<{ result?: { amount?: string }; error?: { cause?: { name?: string } } }>(rpcUrl, {
    jsonrpc: '2.0', id: 'zarf', method: 'query', params: { request_type: 'view_account', finality: 'final', account_id: accountId },
  });
  if (res.error && res.error.cause?.name !== 'UNKNOWN_ACCOUNT') throw new Error('RPC_ERROR');
  if (!res.error && typeof res.result?.amount !== 'string') throw new Error('RPC_ERROR');
  const token = await nearView<string>(rpcUrl, tokenId, 'ft_balance_of', { account_id: accountId });
  return { near: BigInt(res.result?.amount ?? 0), token: BigInt(token) };
}

/** yoctoNEAR as NEAR with up to 4 decimals, e.g. 20000000000000000000000n → "0.02". */
export const formatNear = (yocto: bigint) => (Number(yocto / 10n ** 20n) / 1e4).toString();
