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
    expect(manifest.wallets.map((w) => w.id).sort()).toEqual(['hot-wallet', 'intear-wallet', 'meteor-wallet', 'nightly-wallet']); // ethereum-wallets is added by nearConnectWallet({ ethereum })
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
  type Proto = { checkNewVersion(e: unknown, c: string | null): Promise<string>; loadCode(): Promise<string>; matchesIntegrity(c: string): Promise<boolean> };
  const SandboxExecutor = ((mod as { default?: unknown }).default ?? mod) as { prototype: Proto };
  const code = 'window.selector.ready({})';
  const sha = async (t: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t))), (b) => b.toString(16).padStart(2, '0')).join('');
  // the executor as NEAR Connect builds it (it passes itself to checkNewVersion), with an in-memory cache
  const executor = (integrity?: string, cached: string | null = null) => {
    const saved: string[] = [];
    const self = Object.assign(Object.create(SandboxExecutor.prototype) as Proto, {
      actualCode: null,
      connector: { db: { getItem: async () => cached, setItem: async (_k: string, v: string) => void saved.push(v) } },
      manifest: { id: 'intear-wallet', version: '1', executor: 'https://wallet.intear.tech/near-selector.js', integrity },
    });
    return { self, saved };
  };
  const load = async (integrity?: string) => {
    const { self, saved } = executor(integrity);
    const got = await self.checkNewVersion(self, null);
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
  it('ignores cached code that does not match the pin and waits for the verified download', async () => {
    vi.stubGlobal('fetch', async () => new Response(code));
    const pin = await sha(code);
    expect(await executor(pin, code + ';steal()').self.loadCode()).toBe(code);
    expect(await executor(pin, code).self.loadCode()).toBe(code); // a matching cache is used as before
    vi.stubGlobal('fetch', async () => new Response(code + ';steal()'));
    await expect(executor(pin, code + ';steal()').self.loadCode()).rejects.toThrow(/pinned hash/); // nothing good to run
  });
});

describe('ethereum-wallets (T-002 claim form; senders since T-025)', async () => {
  const { default: eth } = await import('./ethereum-wallets.json');
  it('is the upstream entry, sandboxed, and sign-in needs no key', () => {
    expect(eth.id).toBe('ethereum-wallets');
    expect(eth.type).toBe('sandbox');
    expect(eth.executor).toBe('https://evm-on-near.dev/executor.js');
    expect(eth.features.signInWithoutAddKey).toBe(true);
  });
  it('its executor is pinned by sha256 like Intear\'s (the patched loader refuses another file), on both networks', () => {
    expect(eth.integrity).toBe('0480ca7b4d2204b1702a554e92f6d00d69a780ff1dee9dcf67feb6ae7991556b');
    expect([eth.features.mainnet, eth.features.testnet]).toEqual([true, true]);
  });
});
