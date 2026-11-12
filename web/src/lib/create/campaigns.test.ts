import { describe, expect, it } from 'vitest';
import { claimedAmount, formatNear, listCampaignIds, listCampaigns, mapLimit, reclaimable, reclaimOutcome, reclaimTx, RPC_CONCURRENCY, withdrawTx, type CampaignView, type View, sig3 } from './campaigns';

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

describe('claimedAmount', () => {
  it('is amount minus balance minus in_flight', () => {
    expect(claimedAmount({ amount: '100', balance: '60', in_flight: '15' } as CampaignView)).toBe(25n);
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

describe('mapLimit (RPC concurrency cap)', () => {
  it(`never has more than ${RPC_CONCURRENCY} calls in flight and keeps order`, async () => {
    let inFlight = 0, peak = 0;
    const out = await mapLimit(Array.from({ length: 50 }, (_, i) => i), RPC_CONCURRENCY, async (i) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 1 + (i % 3)));
      inFlight--;
      return i * 2;
    });
    expect(out).toEqual(Array.from({ length: 50 }, (_, i) => i * 2));
    expect(peak).toBe(RPC_CONCURRENCY);
  });
  it('handles fewer items than the limit, and none', async () => {
    expect(await mapLimit([1, 2], 8, async (x) => x)).toEqual([1, 2]);
    expect(await mapLimit([], 8, async (x) => x)).toEqual([]);
  });
});

describe('reclaimOutcome', () => {
  const ev = (event: string, data: object, executor = 'zarf-near.testnet') => ({
    outcome: { executor_id: executor, logs: [`EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event, data: [data] })}`] },
  });
  it('reclaimed with its amount', () => {
    expect(reclaimOutcome({ receipts_outcome: [ev('reclaimed', { campaign_id: '12', amount: '10000000' })] }, 'zarf-near.testnet', '12')).toEqual({ kind: 'reclaimed', amount: '10000000' });
  });
  it('reclaim_reverted: the transfer failed and the balance is back', () => {
    expect(reclaimOutcome({ receipts_outcome: [ev('reclaim_reverted', { campaign_id: '12', amount: '1', code: 'E115_TOKEN_TRANSFER_FAILED' })] }, 'zarf-near.testnet', '12')).toEqual({ kind: 'reverted' });
  });
  it('ignores events of another campaign or another account', () => {
    const o = { receipts_outcome: [ev('reclaim_reverted', { campaign_id: '13' }), ev('reclaim_reverted', { campaign_id: '12' }, 'evil.testnet')] };
    expect(reclaimOutcome(o, 'zarf-near.testnet', '12')).toEqual({ kind: 'released' });
  });
  it('a panic is failed with its code', () => {
    const o = { receipts_outcome: [{ outcome: { executor_id: 'zarf-near.testnet', status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E117_NOT_YET_RECLAIMABLE' } } } } } } }] };
    expect(reclaimOutcome(o, 'zarf-near.testnet', '12')).toEqual({ kind: 'failed', code: 'E117_NOT_YET_RECLAIMABLE' });
  });
});

describe('sig3 (design spec G6f: 3 significant digits in view)', () => {
  const y = (near: number) => BigInt(Math.round(near * 1e9)) * 10n ** 15n;
  it('rounds to 3 significant digits', () => {
    expect(sig3(y(4.99818))).toBe('5.00');
    expect(sig3(y(0.01434))).toBe('0.0143');
    expect(sig3(0n)).toBe('0');
  });
  it('a need rounds up, never down', () => {
    expect(sig3(y(0.01434), true)).toBe('0.0144');
    expect(sig3(y(0.02), true)).toBe('0.0200');
  });
  it('1000 and above is whole NEAR, also when rounding reaches it', () => {
    expect(sig3(y(999.6), true)).toBe('1,000');
    expect(sig3(y(12345.6))).toBe('12,346');
  });
});
