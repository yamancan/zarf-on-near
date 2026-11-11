import { describe, expect, it } from 'vitest';
import { fundingTxs } from './funding';
import { walletRequest } from './wallet';

describe('walletRequest (what NEAR Connect is handed)', () => {
  const base = { merkleRoot: 'ab'.repeat(32), deadlineNs: '1800000000000000000', leafCount: 3, total: '37500000', sender: 'alice.testnet', contractId: 'zarf-near-1112.testnet', tokenId: 'usdc.testnet' };
  it.each([['with a storage shortfall (prepay_deposit, then ft_transfer_call)', 7_090_000_000_000_000_000_000n], ['without one (ft_transfer_call only)', 0n]])('%s: byte-identical to fundingTxs', (_, shortfall) => {
    const txs = fundingTxs({ ...base, shortfall });
    const req = walletRequest(txs);
    expect(req.signerId).toBe('alice.testnet');
    // Same receivers, actions, methods, args, gas and deposits, in the same order; only signerId moves up a level.
    expect(JSON.stringify(req.transactions)).toBe(JSON.stringify(txs.map(({ signerId: _, ...t }) => t)));
    expect(txs.every((t) => t.signerId === 'alice.testnet')).toBe(true);
  });
  it('refuses a mixed-signer batch rather than sign it as one account', () => {
    const txs = fundingTxs({ ...base, shortfall: 1n });
    expect(() => walletRequest([txs[0], { ...txs[1], signerId: 'mallory.testnet' }])).toThrow(/one signer/);
  });
});
