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

describe('pinned wallet list (wallets.json)', async () => {
  const { default: manifest } = await import('./wallets.json');
  it('offers only the reviewed wallets, never MyNearWallet', () => {
    expect(manifest.wallets.map((w) => w.id).sort()).toEqual(['hot-wallet', 'intear-wallet', 'meteor-wallet', 'nightly-wallet']) // senders never get ethereum-wallets;
  });
  it('wallet code from GitHub is pinned to a commit, not a branch (Intear serves its own, see README)', () => {
    for (const w of manifest.wallets) {
      if (w.executor.startsWith('https://raw.githubusercontent.com/')) expect(w.executor).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
      else expect(w.executor).toBe('https://wallet.intear.tech/near-selector.js');
    }
  });
});

describe('ethereum-wallets (claim form only, T-002)', async () => {
  const { default: eth } = await import('./ethereum-wallets.json');
  it('is the upstream entry, sandboxed, and sign-in needs no key', () => {
    expect(eth.id).toBe('ethereum-wallets');
    expect(eth.type).toBe('sandbox');
    expect(eth.executor).toBe('https://evm-on-near.dev/executor.js');
    expect(eth.features.signInWithoutAddKey).toBe(true);
  });
});
