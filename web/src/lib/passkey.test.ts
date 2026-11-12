import { describe, expect, it } from 'vitest';
import { accountFromPrf, passkeyOffered, seedFromPrf } from './passkey';

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
