import { describe, expect, it } from 'vitest';
import { titleCase } from './text';

describe('titleCase (design spec G1)', () => {
  it('caps words, keeps small words low unless first or last', () => {
    expect(titleCase('6 days left')).toBe('6 Days Left');
    expect(titleCase('less than an hour left')).toBe('Less Than an Hour Left');
    expect(titleCase('a way in')).toBe('A Way In');
  });
});
