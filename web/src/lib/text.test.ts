import { describe, expect, it } from 'vitest';
import { titleCase, brandName } from './text';

describe('titleCase (design spec G1)', () => {
  it('caps words, keeps small words low unless first or last', () => {
    expect(titleCase('6 days left')).toBe('6 Days Left');
    expect(titleCase('less than an hour left')).toBe('Less Than an Hour Left');
    expect(titleCase('a way in')).toBe('A Way In');
  });
});

describe('brandName (T-004, red-team UX #5)', () => {
  it('says zarf.to only on a zarf.to host', () => {
    expect(brandName('zarf.to')).toBe('zarf.to');
    expect(brandName('near.zarf.to')).toBe('zarf.to');
    expect(brandName('zarf-near-claim-testnet.sparkling-queen-5e77.workers.dev')).toBe('Zarf');
    expect(brandName('zarf.to.evil.dev')).toBe('Zarf');
    expect(brandName('notzarf.to')).toBe('Zarf');
    expect(brandName('127.0.0.1')).toBe('Zarf');
  });
});
