/**
 * The one validator for a recipient list. The grid paints its result and the
 * wizards gate on it, so what the creator sees and what blocks launch cannot
 * drift apart.
 */

/**
 * A row with neither an identifier nor an amount is an unfinished entry, not a
 * recipient: the grid never flags it, and the wizards drop it before counting,
 * validating or launching.
 */
export function isBlankRow(identifier: string, amount: string): boolean {
    return identifier.trim() === '' && amount.trim() === '';
}

/** How a recipient list reads, normalizes and validates its rows. */
export interface RowRules<T extends { amount: string }> {
    getIdentifier: (row: T) => string;
    normalizeIdentifier: (value: string) => string;
    /** Why a normalized identifier is unusable, or null when it is valid. */
    identifierError: (value: string) => string | null;
    /** Why an amount is unusable, or null when it is valid. */
    amountError: (value: string) => string | null;
    /**
     * Maps a normalized identifier to the key duplicates are grouped by;
     * defaults to identity. The email flow folds Gmail dots, +tags and
     * googlemail, so aliases of one account count as one recipient.
     */
    duplicateKeyOf?: (normalized: string) => string;
}

export interface RowCheck {
    identifierMessage: string | null;
    amountMessage: string | null;
    /** One other row holding the same recipient; bounded even for huge duplicate groups. */
    sameAs: number[];
}

export interface RowIssue {
    index: number;
    message: string;
    field: 'identifier' | 'amount';
}

const PASS: RowCheck = { identifierMessage: null, amountMessage: null, sameAs: [] };

/** Checks every row. Blank rows are unfinished entries, not recipients, and always pass. */
export function checkRows<T extends { amount: string }>(
    rows: readonly T[],
    rules: RowRules<T>,
): RowCheck[] {
    const normalized = rows.map((row) => {
        const identifier = rules.getIdentifier(row);
        return isBlankRow(identifier, row.amount) ? null : rules.normalizeIdentifier(identifier);
    });
    const keys = normalized.map((value) =>
        value ? (rules.duplicateKeyOf ? rules.duplicateKeyOf(value) : value) : null,
    );
    const rowsByKey = new Map<string, number[]>();
    keys.forEach((key, i) => {
        if (key === null) return;
        const group = rowsByKey.get(key);
        if (group) group.push(i);
        else rowsByKey.set(key, [i]);
    });

    return rows.map((row, i) => {
        const value = normalized[i];
        if (value === null) return PASS;
        const key = keys[i];
        const group = key === null ? undefined : rowsByKey.get(key);
        return {
            identifierMessage: rules.identifierError(value),
            amountMessage: rules.amountError(row.amount),
            sameAs: !group || group.length < 2 ? [] : [group[0] === i ? group[1] : group[0]],
        };
    });
}

/** At most one issue per row: the identifier first, then a duplicate, then the amount. */
export function rowIssues(checks: readonly RowCheck[]): RowIssue[] {
    return checks.flatMap((check, index): RowIssue[] => {
        if (check.identifierMessage) {
            return [{ index, message: check.identifierMessage, field: 'identifier' }];
        }
        if (check.sameAs.length > 0) {
            const rows = check.sameAs.map((j) => j + 1).join(', ');
            return [{ index, message: `Same recipient as row ${rows}.`, field: 'identifier' }];
        }
        if (check.amountMessage) {
            return [{ index, message: check.amountMessage, field: 'amount' }];
        }
        return [];
    });
}
