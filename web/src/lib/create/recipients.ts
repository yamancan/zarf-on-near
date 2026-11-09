// CSV → recipients, per spec/claim.md "Email, salt, commitment". Pure: no I/O.

export const USDC_DECIMALS = 6;

/** spec v2: trim ASCII whitespace, require printable ASCII (checked before lowercasing), lowercase. */
export function canonicalEmail(email: string): string {
  const t = email.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!/^[\x21-\x7e]+$/.test(t)) throw new Error('not ASCII');
  return t.toLowerCase();
}

/** "12.5" → 12500000n at 6 decimals. Refuses signs, exponents, extra decimals and zero. */
export function parseAmount(s: string, decimals = USDC_DECIMALS): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m || (m[2] ?? '').length > decimals) throw new Error(`use a number with at most ${decimals} decimals`);
  const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
  if (v === 0n) throw new Error('amount must be above 0');
  if (v >> 128n) throw new Error('amount too large');
  return v;
}

export const formatAmount = (v: bigint, decimals = USDC_DECIMALS): string => {
  const s = v.toString().padStart(decimals + 1, '0');
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return s.slice(0, -decimals) + (frac ? `.${frac}` : '');
};

export interface Row {
  line: number;
  email: string; // canonical: the exact bytes hashed into the commitment
  amount: bigint;
}

export interface Rejected {
  line: number;
  raw: string;
  reason: string;
}

const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_LEAVES = 1 << 20; // proof.len() <= 20

/** One recipient per line: `email,amount` (comma, semicolon or tab). A first line naming the columns is skipped. */
export function parseRecipients(text: string): { rows: Row[]; rejected: Rejected[]; total: bigint } {
  const rows: Row[] = [];
  const rejected: Rejected[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = i + 1;
    if (!raw.trim()) return;
    const cells = raw.split(/[,;\t]/);
    if (line === 1 && /^\s*email\s*$/i.test(cells[0] ?? '')) return; // header
    const reject = (reason: string) => rejected.push({ line, raw, reason });
    if (cells.length !== 2) return reject('expected two columns: email, amount');
    let email: string;
    try {
      email = canonicalEmail(cells[0]);
    } catch {
      return reject('email must be plain ASCII (no accents, no hidden characters)');
    }
    if (!SHAPE.test(email)) return reject('not an email address');
    // Google never puts a +tag Gmail alias in the id_token, so such a row could never be claimed.
    if (/^[^@]*\+[^@]*@(gmail|googlemail)\.com$/.test(email)) return reject('Gmail +aliases cannot sign in; use the account address');
    let amount: bigint;
    try {
      amount = parseAmount(cells[1]);
    } catch (e) {
      return reject((e as Error).message);
    }
    // ft_transfer_call sends the sum as one u128.
    if ((rows.reduce((t, r) => t + r.amount, 0n) + amount) >> 128n) return reject('the total would exceed the token maximum');
    rows.push({ line, email, amount });
  });
  if (rows.length > MAX_LEAVES) {
    for (const r of rows.splice(MAX_LEAVES)) rejected.push({ line: r.line, raw: r.email, reason: `over the ${MAX_LEAVES} recipient limit` });
  }
  return { rows, rejected, total: rows.reduce((t, r) => t + r.amount, 0n) };
}
