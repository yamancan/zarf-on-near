import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
const { connectOrigins } = await import('./hooks.server');

describe('connectOrigins', () => {
  it('keeps the origins of valid http(s) URLs', () => {
    expect(connectOrigins(['https://v.example/claim', 'http://localhost:8787', undefined, ''])).toBe('https://v.example http://localhost:8787');
  });
  it('skips values that are not URLs or not http(s), instead of failing every page', () => {
    expect(connectOrigins(['not a url', 'javascript:alert(1)', "https://ok.example' 'unsafe-inline"])).toBe('');
  });
});

describe('senderPolicy (NEAR Connect on /create, /campaigns and the claim form only)', async () => {
  const { isWalletPage, senderPolicy } = await import('./hooks.server');
  const base = "default-src 'self'; connect-src 'self' https://rpc.example; img-src 'self' data:; script-src 'self' 'nonce-abc'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'";
  it('opens connect, img, style, font and frame to https; never script-src', () => {
    const p = senderPolicy(base);
    expect(p).toContain("connect-src 'self' https://rpc.example https: wss:");
    expect(p).toContain("img-src 'self' data: https:");
    expect(p).toContain("style-src 'self' 'unsafe-inline' https:");
    expect(p).toContain("font-src 'self' https: data:");
    expect(p).toContain("frame-src 'self' https:");
    expect(p).toContain("script-src 'self' 'nonce-abc';");
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).not.toMatch(/dns\.google/); // the MX lookup is gone (T-024): every non-Gmail row is warned
  });
  it('applies to the sender pages only', () => {
    expect(['/create', '/create/', '/campaigns', '/claim/1/ab', '/claim/1/ab/'].every(isWalletPage)).toBe(true);
    expect(['/', '/claim/1/ab/receipt', '/privacy', '/createx', '/auth/google'].some(isWalletPage)).toBe(false);
  });
});
