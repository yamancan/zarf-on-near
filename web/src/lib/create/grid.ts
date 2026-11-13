// The recipient row editor's model (after Zarf's rowChecks.ts). Pure: no I/O.
// It yields the same Row[] parseRecipients does: canonical email, amount in base units. The leaf format is unchanged.

import { ADDR_SPEC, MAX_LEAVES, canonicalEmail, parseAmount, type Rejected, type Row } from './recipients';
import type { RowRules } from '$lib/zarf-kit/create/rowChecks';

export interface GridRow {
  email: string; // as typed
  amount: string; // as typed, decimal
}

export interface RowProblem {
  field: 'email' | 'amount';
  message: string;
}

export const isBlankRow = (r: GridRow) => !r.email.trim() && !r.amount.trim();

/** One Google account behind a Gmail address: dots and +tags fold, googlemail.com is gmail.com. Null for other domains. */
export function gmailAccount(email: string): string | null {
  const m = /^([^@]+)@(gmail|googlemail)\.com$/.exec(email);
  return m ? `${m[1].replace(/\+.*$/, '').replace(/\./g, '')}@gmail.com` : null;
}

export const isGmail = (email: string) => /@(gmail|googlemail)\.com$/i.test(email.trim());

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One row's email on its own (twins are checkGrid's): null when usable. */
export function emailError(raw: string): string | null {
  if (!raw.trim()) return 'Add an email';
  let email: string;
  try {
    email = canonicalEmail(raw);
  } catch {
    return 'Use plain letters only: no accents or hidden characters';
  }
  if (/^mailto:/.test(email) || /^<.*>$/.test(email)) return 'Remove the mailto: or <> around it';
  if (!ADDR_SPEC.test(email)) return 'Not an email';
  // Google never puts a +tag Gmail alias in the id_token, so such a row could never be claimed.
  if (/^[^@]*\+[^@]*@(gmail|googlemail)\.com$/.test(email)) return 'Gmail +alias: use the sign-in address';
  return null;
}

/** One row's amount: null when usable. */
export function amountError(raw: string): string | null {
  if (!raw.trim()) return 'Add an amount';
  // T-010 review minor 3: "1,000.5" is a thousands comma, not too many decimals.
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(raw.trim())) return 'Write it without commas, like 1000.5';
  try {
    parseAmount(raw);
    return null;
  } catch (e) {
    return capital((e as Error).message);
  }
}

/** The same checks as Zarf's grid rules (zarf-kit/create/rowChecks.ts); checkGrid stays the gate. */
export const gridRules: RowRules<GridRow> = {
  getIdentifier: (r) => r.email,
  normalizeIdentifier: (v) => {
    try {
      return canonicalEmail(v);
    } catch {
      return v;
    }
  },
  identifierError: emailError,
  amountError,
  duplicateKeyOf: (e) => gmailAccount(e) ?? e,
};

/**
 * Checks every row. Blank rows are unfinished, never flagged, never sent. At most one problem per row: the email
 * first, then a twin of an earlier row, then the amount. The later row of a pair is the one flagged.
 */
export function checkGrid(rows: readonly GridRow[]): { problems: (RowProblem | null)[]; rows: Row[]; rejected: Rejected[]; total: bigint } {
  const out: Row[] = [];
  const problems: (RowProblem | null)[] = [];
  const firstExact = new Map<string, number>();
  const firstAccount = new Map<string, number>();
  let total = 0n;
  rows.forEach((r, i) => {
    const line = i + 1;
    const flag = (field: RowProblem['field'], message: string) => problems.push({ field, message });
    if (isBlankRow(r)) return problems.push(null);
    const bad = emailError(r.email);
    if (bad) return flag('email', bad);
    const email = canonicalEmail(r.email);
    const same = firstExact.get(email);
    if (same !== undefined) return flag('email', `Listed twice: same as row ${same}`);
    const account = gmailAccount(email);
    const twin = account === null ? undefined : firstAccount.get(account);
    // Two spellings of one Gmail account: only the sign-in spelling can claim, the other share waits for the deadline.
    if (twin !== undefined) return flag('email', `Gmail dot twin of row ${twin}: use the sign-in address`);
    firstExact.set(email, line);
    if (account !== null) firstAccount.set(account, line);
    const badAmount = amountError(r.amount);
    if (badAmount) return flag('amount', badAmount);
    const amount = parseAmount(r.amount);
    // ft_transfer_call sends the sum as one u128.
    if ((total + amount) >> 128n) return flag('amount', 'The total would exceed the token maximum');
    if (out.length >= MAX_LEAVES) return flag('email', `Over the ${MAX_LEAVES} recipient limit`);
    total += amount;
    out.push({ line, email, amount });
    problems.push(null);
  });
  const rejected = problems.flatMap((p, i) => (p ? [{ line: i + 1, raw: rows[i].email, reason: p.message }] : []));
  return { problems, rows: out, rejected, total };
}

/** Splits one line on comma, semicolon or tab, honouring double-quoted cells ("1,000.5"); bare spaces when none. */
function cells(line: string): string[] {
  if (!/[,;\t"]/.test(line)) return line.trim().split(/\s+/);
  const out: string[] = [];
  let cur = '', quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && /[,;\t]/.test(ch)) (out.push(cur), (cur = ''));
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/**
 * A pasted or imported list → rows. Accepts CSV, TSV, `email amount`, or one email per line (amount optional:
 * `sameAmount` fills it). A first line naming the columns is skipped. Lines with no address, or more than two
 * columns, are skipped and named; everything else becomes a row, and the grid checks it like a typed one.
 */
export function parsePaste(text: string, sameAmount = ''): { rows: GridRow[]; skipped: string[] } {
  const rows: GridRow[] = [];
  const skipped: string[] = [];
  let first = true;
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const c = cells(raw);
    while (c.length > 1 && c[c.length - 1] === '') c.pop(); // a spreadsheet's trailing empty columns
    const header = first && !c[0].includes('@') && /^(e-?mail|address|recipient)/i.test(c[0]);
    first = false;
    if (header) return;
    if (c.length > 2) return skipped.push(`Line ${i + 1}: more than two columns`);
    if (!c[0].includes('@')) return skipped.push(`Line ${i + 1}: no email address`);
    rows.push({ email: c[0].toLowerCase(), amount: c[1] || sameAmount.trim() });
  });
  return { rows, skipped };
}
