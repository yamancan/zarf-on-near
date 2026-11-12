import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountBalances, accountFromPrf, formatNear, passkeyOffered, PRF_SALT, seedFromPrf } from './passkey';

const prf = (b: number) => new Uint8Array(32).fill(b);

describe('passkey seed derivation', () => {
  it('the same PRF output always gives the same implicit account', async () => {
    const a = await accountFromPrf(prf(7));
    const b = await accountFromPrf(prf(7).buffer);
    expect(a).toEqual(b);
    expect(a.accountId).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a different PRF output gives a different account', async () => {
    expect((await accountFromPrf(prf(7))).accountId).not.toBe((await accountFromPrf(prf(8))).accountId);
  });
  it('the seed is HKDF over the PRF output, not the PRF output itself', async () => {
    const seed = await seedFromPrf(prf(7));
    expect(seed).toHaveLength(32);
    expect(seed).not.toEqual(prf(7));
  });
  it('pins the derivation: changing salt or info would strand every account', async () => {
    expect((await accountFromPrf(prf(0))).accountId).toBe(PINNED);
  });  it('reads the bytes of the PRF output whatever view the browser hands over (WebAuthn allows any BufferSource)', async () => {
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => i * 7);
    const want = (await accountFromPrf(bytes)).accountId;
    const padded = new Uint8Array(48); padded.set(bytes, 8);
    for (const v of [bytes.buffer, new Uint32Array(bytes.buffer), new DataView(bytes.buffer), new Uint8Array(padded.buffer, 8, 32), new DataView(padded.buffer, 8, 32)])
      expect((await accountFromPrf(v)).accountId).toBe(want);
  });
  it('refuses a PRF output that is not 32 bytes (an empty view never maps to an account)', async () => {
    await expect(accountFromPrf(new DataView(new ArrayBuffer(0)))).rejects.toThrow('PRF_LENGTH');
    await expect(accountFromPrf(new Uint8Array(31))).rejects.toThrow('PRF_LENGTH');
  });
  it('pins the WebAuthn PRF input: changing it changes every account', () => {
    expect(new TextDecoder().decode(PRF_SALT)).toBe('zarf-near/v1');
  });
});

describe('accountBalances', () => {
  afterEach(() => vi.unstubAllGlobals());
  const rpc = (viewAccount: unknown) =>
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.params.request_type === 'view_account') return Response.json(viewAccount);
      return Response.json({ result: { result: [...new TextEncoder().encode('"100000"')] } });
    });
  it('an account that does not exist yet holds 0 NEAR', async () => {
    rpc({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } });
    expect(await accountBalances('https://rpc.test', 'usdc.testnet', 'ab'.repeat(32))).toEqual({ near: 0n, token: 100000n });
  });
  it('any other RPC error is an error, never 0 NEAR', async () => {
    rpc({ error: { name: 'INTERNAL_ERROR' } });
    await expect(accountBalances('https://rpc.test', 'usdc.testnet', 'ab'.repeat(32))).rejects.toThrow('RPC_ERROR');
    rpc({ error: { name: 'INTERNAL_ERROR', cause: { name: 'INTERNAL_ERROR', info: { message: 'account does not exist in this shard' } } } });
    await expect(accountBalances('https://rpc.test', 'usdc.testnet', 'ab'.repeat(32))).rejects.toThrow('RPC_ERROR');
    rpc({ result: {} });
    await expect(accountBalances('https://rpc.test', 'usdc.testnet', 'ab'.repeat(32))).rejects.toThrow('RPC_ERROR');
  });
  it('reads NEAR and the token, and formats NEAR', async () => {
    rpc({ result: { amount: '20000000000000000000000' } });
    const b = await accountBalances('https://rpc.test', 'usdc.testnet', 'ab'.repeat(32));
    expect([formatNear(b.near), b.token]).toEqual(['0.02', 100000n]);
  });
});

describe('passkeyOffered: testnet only, both flags on', () => {
  it('on only with PUBLIC_IMPLICIT_ACCOUNTS=on and PUBLIC_PASSKEY_ACCOUNTS=on on testnet', () => {
    expect(passkeyOffered('testnet', 'on', 'on')).toBe(true);
    for (const [n, i, p] of [['testnet', 'on', ''], ['testnet', '', 'on'], ['testnet', undefined, undefined], ['mainnet', 'on', 'on'], ['', 'on', 'on']] as const)
      expect(passkeyOffered(n, i, p)).toBe(false);
  });
});

const PINNED = '9c6f38521f168f43acb9cd76556d44f6b7fd13aec89b99d2287cfe70c66dc730'; // HKDF + ed25519 computed independently (Python hashlib + cryptography)
