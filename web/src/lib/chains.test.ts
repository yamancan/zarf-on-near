import { describe, expect, it } from 'vitest';
import { chainLogo, PAYOUT_CHAINS } from './chains';

describe('chains.ts: the one chain list both pickers render (T-025)', () => {
  it('each entry has an id, name, pinned asset id, logo and address checks', () => {
    expect(PAYOUT_CHAINS.map((c) => c.key)).toEqual(['base', 'arb', 'eth', 'op', 'pol', 'avax', 'monad', 'sol', 'sui', 'aptos']);
    for (const c of PAYOUT_CHAINS) {
      expect(c.name && c.assetId && c.placeholder).toBeTruthy();
      expect(typeof c.addressError).toBe('function');
      expect(typeof c.depositAddressError).toBe('function');
    }
  });
  it('every logo is a bare 24x24 SVG of shapes only: safe to render with {@html}', () => {
    for (const c of PAYOUT_CHAINS) {
      expect(c.logo, c.key).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" fill="none" viewBox="0 0 24 24">.*<\/svg>$/s);
      const tags = new Set([...c.logo.matchAll(/<\/?([a-zA-Z]+)/g)].map((m) => m[1]));
      expect([...tags].every((t) => ['svg', 'path', 'defs', 'linearGradient', 'stop'].includes(t)), c.key).toBe(true);
      expect(c.logo, c.key).not.toMatch(/\son\w+=|href|url\((?!#)|javascript:|<script/i);
      expect(c.logo.length, c.key).toBeLessThan(1600);
    }
    expect(new Set(PAYOUT_CHAINS.map((c) => c.logo)).size).toBe(PAYOUT_CHAINS.length);
    const ids = PAYOUT_CHAINS.flatMap((c) => [...c.logo.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    expect(new Set(ids).size).toBe(ids.length); // gradients stay distinct when several logos share a page
  });
  it('chainLogo: each rendered instance gets its own gradient ids, and every reference points at its own', () => {
    const sol = PAYOUT_CHAINS.find((c) => c.key === 'sol')!;
    const [a, b] = [chainLogo(sol), chainLogo(sol)];
    const ids = (h: string) => [...h.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const refs = (h: string) => [...h.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
    expect(ids(a)).toHaveLength(3);
    expect(ids(a).some((i) => ids(b).includes(i))).toBe(false);
    for (const h of [a, b]) expect(refs(h).every((r) => ids(h).includes(r))).toBe(true);
    const base = PAYOUT_CHAINS[0];
    expect(chainLogo(base)).toBe(base.logo); // no gradient, nothing to rename
  });
});
