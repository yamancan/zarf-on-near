import { describe, expect, it } from 'vitest';
import { claimCounts, COUNT_CAP, formatNear, listCampaignIds, listCampaigns, reclaimable, reclaimTx, withdrawTx, type CampaignView, type View } from './campaigns';

const campaign = (o: Partial<CampaignView> = {}): CampaignView => ({
  sender: 'alice.testnet', token: 'usdc.testnet', amount: '30000000', merkle_root: 'ab'.repeat(32), deadline_ns: '2000000000000000',
  balance: '10000000', in_flight: '0', policy: 'owner', snapshot: [], storage_reserved: '0', ...o,
});

describe('listCampaignIds / listCampaigns', () => {
  it('pages campaigns_of by 100 until a short page', async () => {
    const all = Array.from({ length: 230 }, (_, i) => String(i));
    const calls: object[] = [];
    const view: View = async (method, args) => {
      calls.push(args);
      const { from_index, limit } = args as { from_index: number; limit: number };
      return all.slice(from_index, from_index + limit) as never;
    };
    expect(await listCampaignIds(view, 'alice.testnet')).toEqual(all);
    expect(calls).toEqual([0, 100, 200].map((from_index) => ({ sender: 'alice.testnet', from_index, limit: 100 })));
  });
  it('stops after an exact multiple of 100 with one empty page', async () => {
    const all = Array.from({ length: 100 }, (_, i) => String(i));
    let calls = 0;
    const view: View = async (_m, a) => (calls++, all.slice((a as { from_index: number }).from_index, (a as { from_index: number }).from_index + 100) as never);
    expect(await listCampaignIds(view, 'x')).toHaveLength(100);
    expect(calls).toBe(2);
  });
  it('newest first; skips ids whose view is null or belongs to someone else', async () => {
    const views: Record<string, CampaignView | null> = { '1': campaign(), '2': null, '3': campaign({ sender: 'mallory.testnet' }), '4': campaign({ amount: '5' }) };
    const view: View = async (method, args) =>
      (method === 'campaigns_of' ? ['1', '2', '3', '4'] : views[(args as { campaign_id: string }).campaign_id]) as never;
    expect((await listCampaigns(view, 'alice.testnet')).map((r) => r.id)).toEqual(['4', '1']);
  });
});

describe('claimCounts', () => {
  it('counts claim_state per commitment', async () => {
    const s: Record<string, string> = { a: 'claimed', b: 'pending', c: 'unclaimed', d: 'claimed' };
    expect(await claimCounts(['a', 'b', 'c', 'd'], async (x) => s[x])).toEqual({ claimed: 2, pending: 1, unclaimed: 1 });
  });
  it(`is n/a (null) above ${COUNT_CAP} leaves, without reading the chain`, async () => {
    let reads = 0;
    expect(await claimCounts(Array(COUNT_CAP + 1).fill('x'), async () => (reads++, 'claimed'))).toBeNull();
    expect(reads).toBe(0);
    expect(await claimCounts(Array(COUNT_CAP).fill('x'), async () => 'claimed')).toEqual({ claimed: COUNT_CAP, pending: 0, unclaimed: 0 });
  });
});

describe('reclaimable', () => {
  const deadlineMs = 2_000_000_000; // deadline_ns 2e15
  it('not before or at the deadline (claim iff now <= deadline)', () => {
    expect(reclaimable(campaign(), deadlineMs).ok).toBe(false);
    expect(reclaimable(campaign(), deadlineMs - 1).ok).toBe(false);
  });
  it('after the deadline with a balance, or with only a reservation left', () => {
    expect(reclaimable(campaign(), deadlineMs + 1)).toEqual({ ok: true });
    expect(reclaimable(campaign({ balance: '0', storage_reserved: '5' }), deadlineMs + 1)).toEqual({ ok: true });
  });
  it('nothing to reclaim when both are 0', () => {
    expect(reclaimable(campaign({ balance: '0', storage_reserved: '0' }), deadlineMs + 1)).toEqual({ ok: false, reason: 'Nothing left to reclaim.' });
  });
  it('in-flight funds alone do not make it reclaimable', () => {
    expect(reclaimable(campaign({ balance: '0', in_flight: '10', storage_reserved: '0' }), deadlineMs + 1).ok).toBe(false);
  });
});

describe('transactions', () => {
  it('reclaim and prepay_withdraw: our contract, zero deposit', () => {
    expect(reclaimTx('alice.testnet', 'zarf-near.testnet', '12')).toEqual({
      signerId: 'alice.testnet', receiverId: 'zarf-near.testnet',
      actions: [{ type: 'FunctionCall', params: { methodName: 'reclaim', args: { campaign_id: '12' }, gas: '100000000000000', deposit: '0' } }],
    });
    expect(withdrawTx('alice.testnet', 'zarf-near.testnet').actions[0].params).toEqual({ methodName: 'prepay_withdraw', args: {}, gas: '30000000000000', deposit: '0' });
  });
  it('formats yoctoNEAR', () => {
    expect(formatNear('0')).toBe('0');
    expect(formatNear('10000000000000000000000')).toBe('0.01');
    expect(formatNear('1234567890000000000000000')).toBe('1.23456');
  });
});
