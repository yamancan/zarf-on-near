import { describe, expect, it } from 'vitest';
import { checkGrid, gmailAccount, gridRules, isGmail, parsePaste, type GridRow } from './grid';
import { parseRecipients, sendCapError } from './recipients';

const r = (email: string, amount: string): GridRow => ({ email, amount });
const messages = (rows: GridRow[]) => checkGrid(rows).problems.map((p) => (p ? `${p.field}: ${p.message}` : null));

describe('checkGrid: one plain-words problem per row', () => {
  it('passes good rows and yields the same leaves parseRecipients does', () => {
    const rows = [r(' Alice@Gmail.com ', '10'), r('bob@acme.io', '2.5')];
    const g = checkGrid(rows);
    expect(g.problems).toEqual([null, null]);
    const p = parseRecipients('alice@gmail.com,10\nbob@acme.io,2.5');
    expect(g.rows).toEqual(p.rows);
    expect(g.total).toBe(12_500_000n);
  });
  it('flags a bad email, a missing amount and bad amounts on their own row', () => {
    expect(messages([r('alice', '1'), r('a@b.co', ''), r('c@d.co', '0'), r('e@f.co', '1.1234567'), r('g@h.co', '-1'), r('', '5')])).toEqual([
      'email: Not an email',
      'amount: Add an amount',
      'amount: Amount must be above 0',
      'amount: Use a number with at most 6 decimals',
      'amount: Use a number with at most 6 decimals',
      'email: Add an email',
    ]);
    expect(messages([r('ålice@x.co', '1'), r('<a@x.co>', '1')])).toEqual([
      'email: Use plain letters only: no accents or hidden characters',
      'email: Remove the mailto: or <> around it',
    ]);
  });
  it('flags duplicates, Gmail dot twins and +aliases, on the later row', () => {
    expect(messages([r('alice@gmail.com', '1'), r('ALICE@gmail.com', '1'), r('a.lice@googlemail.com', '1'), r('alice+pay@gmail.com', '1'), r('a.lice@acme.io', '1'), r('alice@acme.io', '1')])).toEqual([
      null,
      'email: Listed twice: same as row 1',
      'email: Gmail dot twin of row 1: use the sign-in address',
      'email: Gmail +alias: use the sign-in address',
      null,
      null, // dots only fold for Gmail
    ]);
  });
  it('blank rows are unfinished, never flagged, never sent; totals count good rows only', () => {
    const g = checkGrid([r('', ''), r('a@b.co', '1.5'), r('  ', ' '), r('bad', '9')]);
    expect(g.problems.map(Boolean)).toEqual([false, false, false, true]);
    expect(g.rows.map((x) => x.line)).toEqual([2]);
    expect(g.total).toBe(1_500_000n);
    expect(g.rejected).toEqual([{ line: 4, raw: 'bad', reason: 'Not an email' }]);
  });
  it('limits: the u128 total, and the mainnet send cap on the total', () => {
    const big = (2n ** 127n / 1_000_000n).toString();
    expect(messages([r('a@b.co', big), r('c@d.co', big), r('e@f.co', '1')])[2]).toBe('amount: The total would exceed the token maximum');
    const g = checkGrid([r('a@b.co', '60'), r('c@d.co', '40.000001')]);
    expect(sendCapError(g.total, false)).toMatch(/up to 100 USDC/);
    expect(sendCapError(checkGrid([r('a@b.co', '100')]).total, false)).toBeNull();
  });
});

describe('gmail helpers', () => {
  it('folds one Gmail account and marks Gmail addresses', () => {
    expect(gmailAccount('a.l.ice+x@googlemail.com')).toBe('alice@gmail.com');
    expect(gmailAccount('a.lice@acme.io')).toBeNull();
    expect([isGmail('x@gmail.com'), isGmail('X@GoogleMail.com'), isGmail('x@gmail.co')]).toEqual([true, true, false]);
  });
});

describe('parsePaste', () => {
  it('reads CSV, semicolons, TSV and space-separated lines, with a header row', () => {
    const p = parsePaste('Email,Amount\r\nalice@gmail.com,10\nBob@x.io;2.5\ncarol@y.io\t3\ndan@z.io 4\n\n');
    expect(p.rows).toEqual([r('alice@gmail.com', '10'), r('bob@x.io', '2.5'), r('carol@y.io', '3'), r('dan@z.io', '4')]);
    expect(p.skipped).toEqual([]);
  });
  it('one email per line takes the same amount for all, or leaves it for the grid to ask', () => {
    expect(parsePaste('a@b.co\nc@d.co,7', '5').rows).toEqual([r('a@b.co', '5'), r('c@d.co', '7')]);
    expect(parsePaste('a@b.co').rows).toEqual([r('a@b.co', '')]);
  });
  it('honours quoted cells and trailing empty columns', () => {
    expect(parsePaste('"a@b.co","1,000.5"\n"c@d.co",2,,').rows).toEqual([r('a@b.co', '1,000.5'), r('c@d.co', '2')]);
  });
  it('skips and names lines with no address or too many columns; bad amounts still become rows for the grid', () => {
    const p = parsePaste('a@b.co,1,2\nhello,5\nc@d.co,abc\n﻿');
    expect(p.skipped).toEqual(['Line 1: more than two columns', 'Line 2: no email address']);
    expect(p.rows).toEqual([r('c@d.co', 'abc')]);
    expect(checkGrid(p.rows).problems[0]?.message).toBe('Use a number with at most 6 decimals');
  });
  it('only the first line can be a header', () => {
    expect(parsePaste('a@b.co,1\nemail,amount').skipped).toEqual(['Line 2: no email address']);
  });
});

describe('thousands comma (T-010 review minor 3)', () => {
  it('says to drop the comma, not to use fewer decimals', () => {
    const { problems } = checkGrid([{ email: 'a@gmail.com', amount: '1,000.5' }]);
    expect(problems[0]?.message).toBe('Write it without commas, like 1000.5');
  });
});

describe("gridRules: Zarf's grid flags the rows checkGrid refuses (T-024)", () => {
  it('the same rows are flagged, so what the grid shows and what blocks Continue agree', async () => {
    const { checkRows, rowIssues } = await import('$lib/zarf-kit/create/rowChecks');
    const rows: GridRow[] = [
      { email: 'alice@gmail.com', amount: '10' },
      { email: 'not-an-email', amount: '5' },
      { email: 'a.lice@gmail.com', amount: '1' }, // a Gmail dot twin of row 1
      { email: 'bob+x@gmail.com', amount: '1' }, // Gmail +alias
      { email: 'carol@example.com', amount: '1,000.5' },
      { email: '', amount: '' }, // blank: never flagged
      { email: 'dave@example.com', amount: '' },
      { email: 'erin@example.com', amount: '2.5' },
    ];
    const zarf = rowIssues(checkRows(rows, gridRules)).map((i) => i.index + 1);
    const ours = checkGrid(rows).rejected.map((r) => r.line);
    expect(ours).toEqual([2, 3, 4, 5, 7]);
    // Zarf marks both rows of a twin pair (row 1 "Same recipient as row 3"); the gate refuses the later one. Fixing
    // either clears both, so the only extra rows are first halves of pairs.
    expect(zarf).toEqual([1, ...ours]);
  });
});
