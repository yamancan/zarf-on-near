import { describe, expect, it, vi } from 'vitest';
import { loadPendingClaim, savePendingClaim, recoverPendingClaim } from './claim-recovery';
import { loadReceipt, saveReceipt, type Attempt } from './claim';

const K = 'zarf.near', C = '7', H = 'a'.repeat(64), NOW = 1_800_000_000_000;
const TX = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm';
const attempt: Attempt = { campaign: C, commitment: H, salt: 'b'.repeat(64), proof: [], amount: '10000000',
  destination: 'd'.repeat(64), attemptId: 'secret-oauth-state', intents: { chainName: 'Base', recipient: '0x1234',
    refundTo: 'sender.near', assetId: 'asset', requestDeadline: new Date(NOW + 3600000).toISOString(), amountOutFormatted: '9.99' } };
const mem = (): Storage => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } as Storage;
};
const clock = () => { let now = NOW; return { now: () => now, sleep: async (ms: number) => { now += ms; }, timeoutMs: 2000 }; };

describe('pending claim recovery after losing the tab memory', () => {
  it('recovers a native NEAR claim with its destination and passkey affordance', async () => {
    const s = mem();
    savePendingClaim('testnet', K, { ...attempt, destination: 'alice.testnet', intents: undefined, passkey: true }, TX, s, NOW);
    const pending = loadPendingClaim('testnet', K, C, H, s, NOW)!;
    const result = await recoverPendingClaim('testnet', K, C, H, pending, async () => 'claimed', s, clock());
    expect(result.receipt).toMatchObject({ destination: 'alice.testnet', passkey: true, txHash: TX });
    expect(result.receipt).not.toHaveProperty('chainName');
    expect(loadReceipt(K, C, H, s, NOW + 29 * 86400000)).not.toBeNull();
    expect(loadReceipt(K, C, H, s, NOW + 30 * 86400000)).toBeNull();
  });
  it('starts the confirmed receipt retention at confirmation, not at the old submission time', async () => {
    const s = mem();
    savePendingClaim('mainnet', K, attempt, TX, s, NOW - 2 * 86400000);
    await recoverPendingClaim('mainnet', K, C, H, loadPendingClaim('mainnet', K, C, H, s, NOW)!, async () => 'claimed', s, clock());
    expect(loadReceipt(K, C, H, s, NOW + 29 * 86400000)).not.toBeNull();
  });
  it('does not erase a settled bridge receipt written by another tab during recovery', async () => {
    const s = mem();
    savePendingClaim('mainnet', K, attempt, TX, s, NOW);
    const pending = loadPendingClaim('mainnet', K, C, H, s, NOW)!;
    const result = await recoverPendingClaim('mainnet', K, C, H, pending, async () => {
      saveReceipt(K, C, H, { ...pending, bridge: 'paid', amountOut: '9.99', bridgeStatus: { status: 'SUCCESS' } }, s, NOW);
      return 'claimed';
    }, s, clock());
    expect(result.receipt).toMatchObject({ bridge: 'paid', amountOut: '9.99', bridgeStatus: { status: 'SUCCESS' } });
  });
  it('keeps a still-settling claim and its public cross-chain destination without retaining credentials', async () => {
    const s = mem();
    savePendingClaim('mainnet', K, attempt, TX, s, NOW);
    const pending = loadPendingClaim('mainnet', K, C, H, s, NOW + 1)!;
    expect(pending).toMatchObject({ amount: '10000000', destination: '0x1234', txHash: TX,
      chainName: 'Base', depositAddress: 'd'.repeat(64), refundTo: 'sender.near' });
    for (const secret of [attempt.salt, attempt.attemptId, 'requestDeadline', 'assetId', 'proof', 'idToken', 'privateKey']) {
      expect(JSON.stringify(pending)).not.toContain(secret);
    }
    const result = await recoverPendingClaim('mainnet', K, C, H, pending, async () => 'pending', s, clock());
    expect(result.state).toBe('pending');
    expect(loadPendingClaim('mainnet', K, C, H, s, NOW + 2)).not.toBeNull();
    expect(loadReceipt(K, C, H, s, NOW + 2)).toBeNull();
  });
  it('recovers a lost relayer answer by reading the chain only, then saves a confirmed receipt', async () => {
    const s = mem();
    savePendingClaim('mainnet', K, attempt, '', s, NOW);
    const read = vi.fn().mockResolvedValueOnce('pending').mockResolvedValueOnce('claimed');
    const r = await recoverPendingClaim('mainnet', K, C, H, loadPendingClaim('mainnet', K, C, H, s, NOW)!, read, s, clock());
    expect(r.state).toBe('claimed');
    expect(loadReceipt(K, C, H, s, NOW + 2000)).toMatchObject({ txHash: '', chainName: 'Base', bridge: 'in-transit' });
    expect(loadPendingClaim('mainnet', K, C, H, s, NOW + 2000)).toBeNull();
  });
  it('a failed chain read never turns a pending payment into a retry or receipt', async () => {
    const s = mem();
    savePendingClaim('mainnet', K, attempt, TX, s, NOW);
    const r = await recoverPendingClaim('mainnet', K, C, H, loadPendingClaim('mainnet', K, C, H, s, NOW)!, async () => { throw Error('offline'); }, s, clock());
    expect(r.state).toBe('pending');
    expect(loadPendingClaim('mainnet', K, C, H, s, NOW + 2000)).not.toBeNull();
    expect(loadReceipt(K, C, H, s, NOW + 2000)).toBeNull();
  });
  it('an unclaimed read after pending is not proof of failure and keeps recovery metadata', async () => {
    const s = mem();
    savePendingClaim('mainnet', K, attempt, TX, s, NOW);
    const read = vi.fn().mockResolvedValueOnce('pending').mockResolvedValueOnce('unclaimed');
    expect((await recoverPendingClaim('mainnet', K, C, H, loadPendingClaim('mainnet', K, C, H, s, NOW)!, read, s, clock())).state).toBe('pending');
    expect(loadPendingClaim('mainnet', K, C, H, s, NOW + 2000)).not.toBeNull();
    expect(loadReceipt(K, C, H, s, NOW + 2000)).toBeNull();
  });
  it('retains a submitted transaction when unclaimed outlasts the usual 20-second grace', async () => {
    const s = mem();
    savePendingClaim('mainnet', K, attempt, TX, s, NOW);
    const result = await recoverPendingClaim('mainnet', K, C, H, loadPendingClaim('mainnet', K, C, H, s, NOW)!,
      async () => 'unclaimed', s, { ...clock(), timeoutMs: 60000 });
    expect(result.state).toBe('pending');
    expect(loadPendingClaim('mainnet', K, C, H, s, NOW + 60000)).toMatchObject({ txHash: TX, depositAddress: 'd'.repeat(64) });
    expect(loadReceipt(K, C, H, s, NOW + 60000)).toBeNull();
  });
  it('isolates contracts and claims and expires metadata after 30 days without extending it on hash updates', () => {
    const s = mem();
    savePendingClaim('mainnet', K, attempt, '', s, NOW);
    savePendingClaim('mainnet', K, attempt, TX, s, NOW + 1000);
    expect(loadPendingClaim('testnet', K, C, H, s, NOW + 1000)).toBeNull();
    expect(loadPendingClaim('mainnet', 'other.near', C, H, s, NOW + 1000)).toBeNull();
    expect(loadPendingClaim('mainnet', K, '8', H, s, NOW + 1000)).toBeNull();
    expect(loadPendingClaim('mainnet', K, C, H, s, NOW + 30 * 86400000)).toBeNull();
  });
  it('refuses malformed or future-dated browser records and fails safely when storage is blocked', () => {
    const s = mem();
    for (const fields of [{ amount: 'no' }, { txHash: 'javascript:alert(1)' }, { depositAddress: 'bad' },
      { savedAt: NOW + 1 }, { destination: {} }, { savedAt: 'yesterday' }]) {
      s.setItem(`zarf-near:pending:mainnet/${K}/${C}/${H}`, JSON.stringify({ amount: '1', destination: 'alice.near', txHash: '', savedAt: NOW, ...fields }));
      expect(loadPendingClaim('mainnet', K, C, H, s, NOW)).toBeNull();
    }
    const denied = { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } } as unknown as Storage;
    expect(loadPendingClaim('mainnet', K, C, H, denied, NOW)).toBeNull();
    expect(() => savePendingClaim('mainnet', K, attempt, TX, denied, NOW)).toThrow();
  });
});
