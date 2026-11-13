<script lang="ts" generics="T extends { amount: string }">
    import { tick } from 'svelte';
    import { Trash2, AlertTriangle } from 'lucide-svelte';
    import ZenButton from '../components/ui/ZenButton.svelte';
    import { formatAmount } from './format';
    import { checkRows, isBlankRow, rowIssues, type RowIssue, type RowRules } from './rowChecks';

    interface SummaryItem {
        label: string;
        value: string | number;
        suffix?: string;
        tone?: 'error';
    }

    interface Props<T extends { amount: string }> {
        rows: T[];
        identifierLabel: string;
        identifierPlaceholder: string;
        identifierInputType?: 'email' | 'text';
        tokenSymbol?: string;
        rules: RowRules<T>;
        withIdentifier: (row: T, value: string) => T;
        withAmount: (row: T, value: string) => T;
        /** Called after a typed edit. */
        onRowsEdited?: () => void;
        /** Called just before a row is removed, while `rows` still holds it. */
        onRemoveRow?: (index: number) => void;
        /** Seed for the editable row shown while `rows` is empty; typing into it creates the first row. */
        blankRow: T;
        /** Set after an action that threw rows away; shown under the table with an Undo button. */
        undoLabel?: string | null;
        onUndo?: () => void;
        showSummary?: boolean;
        summaryItems?: SummaryItem[];
    }

    let {
        rows = $bindable(),
        identifierLabel,
        identifierPlaceholder,
        identifierInputType = 'text',
        tokenSymbol = 'tokens',
        rules,
        withIdentifier,
        withAmount,
        onRowsEdited,
        onRemoveRow,
        blankRow,
        undoLabel = null,
        onUndo,
        showSummary = true,
        summaryItems,
    }: Props<T> = $props();

    const uid = $props.id();

    // Keep row numbers visible on phones so the issue list's references remain usable.
    const columns =
        'grid-cols-[2rem_minmax(0,1fr)_5rem_2rem] sm:grid-cols-[2.5rem_minmax(0,1fr)_7rem_2.5rem]';

    const total = $derived(
        rows.reduce(
            (sum, row) => sum + (rules.amountError(row.amount) === null ? Number(row.amount) : 0),
            0,
        ),
    );
    const displayedSummaryItems = $derived(
        summaryItems ?? [
            {
                label: 'Recipients',
                value: rows.filter((row) => !isBlankRow(rules.getIdentifier(row), row.amount))
                    .length,
            },
            { label: 'Total', value: formatAmount(total), suffix: tokenSymbol },
        ],
    );

    // An empty grid still shows one editable row, so the creator sees where to type.
    const hasRows = $derived(rows.length > 0);
    const displayRows = $derived(hasRows ? rows : [blankRow]);

    const checks = $derived(checkRows(displayRows, rules));
    const issues = $derived(rowIssues(checks));
    const issueAt = $derived.by(() => {
        const byRow: (RowIssue | undefined)[] = [];
        for (const issue of issues) byRow[issue.index] = issue;
        return byRow;
    });
    const describedBy = (index: number, field: RowIssue['field']) =>
        issueAt[index]?.field === field ? `${uid}-issue-${index}` : undefined;

    const identifierInputs = $state<HTMLInputElement[]>([]);
    const amountInputs = $state<HTMLInputElement[]>([]);

    function focusRow({ index, field }: RowIssue) {
        (field === 'identifier' ? identifierInputs : amountInputs)[index]?.focus();
    }

    /**
     * Focuses a row's identifier once it has rendered. Add row calls this: the
     * new row lands below the scroll fold, and focus scrolls it into view.
     */
    export async function focusIdentifier(index: number) {
        await tick();
        identifierInputs[index]?.focus();
    }

    function updateIdentifier(index: number, value: string) {
        rows = displayRows.map((row, i) => (i === index ? withIdentifier(row, value) : row));
        onRowsEdited?.();
    }

    function normalizeRowIdentifier(index: number) {
        const identifier = rules.getIdentifier(displayRows[index]);
        const normalized = rules.normalizeIdentifier(identifier);
        if (normalized !== identifier) updateIdentifier(index, normalized);
    }

    function updateAmount(index: number, value: string) {
        rows = displayRows.map((row, i) => (i === index ? withAmount(row, value) : row));
        onRowsEdited?.();
    }

    function deleteRow(index: number) {
        onRemoveRow?.(index);
        rows = rows.filter((_, i) => i !== index);
    }
</script>

<div class="overflow-hidden rounded-2xl border border-zen-border-subtle bg-zen-bg">
    <div
        class="grid {columns} items-center gap-2 border-b border-zen-border-subtle bg-zen-fg/[0.02] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-zen-fg-subtle"
    >
        <span>#</span>
        <span>{identifierLabel}</span>
        <span class="text-right">Amount</span>
        <span></span>
    </div>

    <div class="max-h-[420px] divide-y divide-zen-border-subtle overflow-y-auto">
        {#each displayRows as row, i (i)}
            {@const check = checks[i]}
            {@const duplicate = check.sameAs.length > 0}
            {@const badIdentifier = check.identifierMessage !== null || duplicate}
            {@const badAmount = check.amountMessage !== null}
            {@const invalid = badIdentifier || badAmount}
            <div
                class="grid {columns} items-center gap-2 px-3 py-2 hover:bg-zen-fg/[0.02] {invalid
                    ? 'bg-zen-error/5'
                    : ''}"
            >
                <span
                    class="flex items-center gap-1 text-xs tabular-nums {invalid
                        ? 'text-zen-error'
                        : 'text-zen-fg-faint'}"
                >
                    {i + 1}
                    {#if invalid}<AlertTriangle class="hidden h-3 w-3 sm:block" />{/if}
                </span>
                <!-- Phones get 16px inputs: iOS Safari zooms the page on focus below that. -->
                <div class="flex min-w-0 items-center gap-2">
                    <input
                        bind:this={identifierInputs[i]}
                        type={identifierInputType}
                        value={rules.getIdentifier(row)}
                        oninput={(event) => updateIdentifier(i, event.currentTarget.value)}
                        onblur={() => normalizeRowIdentifier(i)}
                        autocomplete="off"
                        spellcheck="false"
                        aria-label={`Recipient ${i + 1} ${identifierLabel.toLowerCase()}`}
                        aria-invalid={badIdentifier}
                        aria-describedby={describedBy(i, 'identifier')}
                        placeholder={identifierPlaceholder}
                        class="-mx-1.5 min-w-0 flex-1 rounded bg-transparent px-1.5 py-1 font-mono text-base text-zen-fg focus:outline-none focus:ring-1 focus:ring-zen-fg/30 sm:text-xs {badIdentifier
                            ? 'text-zen-error'
                            : ''}"
                    />
                    {#if duplicate}
                        <span
                            class="rounded bg-zen-error/10 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zen-error"
                            >DUP</span
                        >
                    {/if}
                </div>
                <input
                    bind:this={amountInputs[i]}
                    type="text"
                    inputmode="decimal"
                    value={row.amount}
                    oninput={(event) => updateAmount(i, event.currentTarget.value)}
                    aria-label={`Recipient ${i + 1} amount`}
                    aria-invalid={badAmount}
                    aria-describedby={describedBy(i, 'amount')}
                    placeholder="0"
                    class="h-8 w-full rounded-lg border bg-zen-fg/[0.03] px-2.5 text-right font-mono text-base tabular-nums text-zen-fg focus:border-zen-fg/40 focus:outline-none sm:text-xs {badAmount
                        ? 'border-zen-error/40 text-zen-error'
                        : 'border-zen-border'}"
                />
                {#if hasRows}
                    <button
                        type="button"
                        onclick={() => deleteRow(i)}
                        aria-label={`Remove recipient ${i + 1}`}
                        class="flex h-8 w-8 items-center justify-center rounded text-zen-fg-faint transition-colors hover:bg-zen-error/10 hover:text-zen-error"
                    >
                        <Trash2 class="h-3.5 w-3.5" />
                    </button>
                {/if}
            </div>
        {/each}
    </div>
</div>

<!-- Under the table, so a delete never pushes the remaining rows away from the cursor. -->
{#if undoLabel}
    <div
        role="status"
        class="flex items-center justify-between gap-3 rounded-xl bg-zen-fg/[0.03] px-3 py-2 text-sm text-zen-fg-muted"
    >
        <span>{undoLabel}</span>
        <ZenButton variant="ghost" size="sm" onclick={onUndo}>Undo</ZenButton>
    </div>
{/if}

{#if issues.length > 0}
    <div class="rounded-xl bg-zen-error/5 p-3 text-xs text-zen-error">
        <div class="flex items-center gap-2 font-semibold">
            <AlertTriangle class="h-4 w-4" />
            {issues.length === 1 ? '1 row needs fixing' : `${issues.length} rows need fixing`}
        </div>
        <ul class="mt-1 max-h-32 space-y-0.5 overflow-y-auto pl-6">
            {#each issues as issue (issue.index)}
                <li>
                    <button
                        type="button"
                        id="{uid}-issue-{issue.index}"
                        onclick={() => focusRow(issue)}
                        class="text-left underline-offset-2 hover:underline"
                    >
                        Row {issue.index + 1}: {issue.message}
                    </button>
                </li>
            {/each}
        </ul>
    </div>
{/if}

{#if showSummary}
    <div class="flex flex-wrap items-center gap-6 px-1">
        {#each displayedSummaryItems as item (item.label)}
            <div>
                <span class="block text-[10px] uppercase tracking-wider text-zen-fg-muted">
                    {item.label}
                </span>
                <span
                    class="text-lg font-semibold tabular-nums {item.tone === 'error'
                        ? 'text-zen-error'
                        : 'text-zen-fg'}"
                >
                    {item.value}
                    {#if item.suffix}
                        <span class="text-xs font-normal text-zen-fg-subtle">{item.suffix}</span>
                    {/if}
                </span>
            </div>
        {/each}
    </div>
{/if}
