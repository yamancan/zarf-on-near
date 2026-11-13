// Copied from zarf web/packages/core/lib/utils/format.ts:1-30 (formatAmount only).
/**
 * Display formatters locked to en-US.
 *
 * The UI ships in English; explicit-locale `Intl.NumberFormat` and
 * `Intl.DateTimeFormat` keep the rendered output deterministic
 * regardless of the user's browser or OS locale. Bare `.toLocaleString()`
 * / `.toLocaleDateString()` calls fall back to navigator.language and
 * render `1.234,56` on a Turkish locale where the design expects
 * `1,234.56` — these helpers close that drift.
 */


const AMOUNT_FORMATTER = new Intl.NumberFormat('en-US');

/**
 * Format a numeric amount using en-US grouping ("1,234,567").
 * Accepts number, bigint, or numeric string. Returns "—" for
 * non-finite numbers and parse failures so callers don't have to
 * spread NaN guards across every template.
 */
export function formatAmount(value: number | bigint | string): string {
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return '—';
        return AMOUNT_FORMATTER.format(parsed);
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return '—';
    return AMOUNT_FORMATTER.format(value);
}
