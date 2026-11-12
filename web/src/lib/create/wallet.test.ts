import { describe, expect, it, vi } from 'vitest';
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
  it('every wallet\'s code is pinned: a GitHub commit URL, or a sha256 the patched loader checks (Intear, T-004)', () => {
    for (const w of manifest.wallets as { executor: string; integrity?: string }[]) {
      if (w.executor.startsWith('https://raw.githubusercontent.com/')) expect(w.executor).toMatch(/^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//);
      else expect(w.integrity).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe('patched NEAR Connect loader: integrity pin (patches/@hot-labs__near-connect@0.12.0.patch)', async () => {
  const { default: mod } = await import('@hot-labs/near-connect/build/SandboxedWallet/executor.js');
  const SandboxExecutor = ((mod as { default?: unknown }).default ?? mod) as { prototype: { checkNewVersion(e: unknown, c: string | null): Promise<string> } };
  const code = 'window.selector.ready({})';
  const sha = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))), (b) => b.toString(16).padStart(2, '0')).join('');
  const load = async (integrity?: string) => {
    const saved: string[] = [];
    const self = { actualCode: null, connector: { db: { setItem: async (_k: string, v: string) => void saved.push(v) } }, manifest: { id: 'intear-wallet', version: '1' } };
    const executor = { manifest: { id: 'intear-wallet', executor: 'https://wallet.intear.tech/near-selector.js', integrity } };
    const got = await SandboxExecutor.prototype.checkNewVersion.call(self, executor, null);
    return { got, saved };
  };
  it('runs and caches the file whose hash matches', async () => {
    vi.stubGlobal('fetch', async () => new Response(code));
    expect(await load(await sha(code))).toEqual({ got: code, saved: [code] });
  });
  it('refuses a changed file: never returned, never cached', async () => {
    vi.stubGlobal('fetch', async () => new Response(code + ';steal()'));
    await expect(load(await sha(code))).rejects.toThrow(/pinned hash/);
  });
  it('leaves unpinned entries (GitHub commit URLs) as they were', async () => {
    vi.stubGlobal('fetch', async () => new Response(code));
    expect((await load()).got).toBe(code);
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
