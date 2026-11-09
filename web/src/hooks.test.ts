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
