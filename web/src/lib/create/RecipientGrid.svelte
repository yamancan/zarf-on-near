<script lang="ts">
  // Zarf's RecipientAllocationGrid (apps/create/src/lib/components/recipients), with each row's problem on that row.
  import { tick } from 'svelte';
  import { AlertTriangle, Info, Mail, Trash2 } from 'lucide-svelte';
  import { formatAmount } from './recipients';
  import { isBlankRow, isGmail, type GridRow, type RowProblem } from './grid';

  let {
    rows = $bindable(),
    problems,
    notGoogle,
    total,
    count,
    unit,
    disabled = false,
  }: {
    rows: GridRow[];
    problems: (RowProblem | null)[];
    notGoogle: (index: number) => boolean;
    total: bigint;
    count: number;
    unit: string;
    disabled?: boolean;
  } = $props();

  const uid = $props.id();
  // Row numbers stay on phones: the problem lines and "same as row N" refer to them.
  const columns = 'grid-cols-[1.5rem_minmax(0,1fr)_5rem_2rem] sm:grid-cols-[2rem_minmax(0,1fr)_7rem_2.5rem]';
  const emailInputs = $state<HTMLInputElement[]>([]);
  const amountInputs = $state<HTMLInputElement[]>([]);
  const blank = (): GridRow => ({ email: '', amount: '' });

  /** Adds a row at the end and puts the cursor in its email. */
  export async function addRow() {
    rows = [...rows, blank()];
    await tick();
    emailInputs[rows.length - 1]?.focus();
  }

  const set = (i: number, patch: Partial<GridRow>) => (rows = rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function remove(i: number) {
    rows = rows.length > 1 ? rows.filter((_, j) => j !== i) : [blank()];
    await tick();
    emailInputs[Math.min(i, rows.length - 1)]?.focus();
  }

  function onAmountKey(e: KeyboardEvent, i: number) {
    const last = i === rows.length - 1;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (last) addRow();
      else emailInputs[i + 1]?.focus();
    } else if (e.key === 'Tab' && !e.shiftKey && last && !isBlankRow(rows[i])) {
      e.preventDefault();
      addRow();
    }
  }
</script>

<div class="overflow-hidden rounded-2xl border border-zen-border-subtle bg-zen-bg">
  <div class="grid {columns} items-center gap-2 border-b border-zen-border-subtle bg-zen-fg/[0.02] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-zen-fg-subtle" aria-hidden="true">
    <span>#</span>
    <span>Email</span>
    <span class="text-right">Amount</span>
    <span></span>
  </div>

  <ul class="max-h-[420px] divide-y divide-zen-border-subtle overflow-y-auto" aria-label="Recipients">
    {#each rows as row, i (i)}
      {@const p = problems[i]}
      {@const badEmail = p?.field === 'email'}
      {@const badAmount = p?.field === 'amount'}
      {@const hint = !p && notGoogle(i)}
      <li class="grid {columns} items-center gap-x-2 gap-y-1 px-3 py-2 hover:bg-zen-fg/[0.02] {p ? 'bg-zen-error/5' : ''}">
        <span class="flex items-center gap-1 text-xs tabular-nums {p ? 'text-zen-error' : 'text-zen-fg-faint'}">
          {i + 1}{#if p}<AlertTriangle class="hidden h-3 w-3 sm:block" aria-hidden="true" />{/if}
        </span>
        <div class="flex min-w-0 items-center gap-2">
          {#if isGmail(row.email)}
            <img src="/google/gmail.svg" alt="" width="14" height="14" class="h-3.5 w-3.5 shrink-0" />
          {:else}
            <Mail class="h-3.5 w-3.5 shrink-0 text-zen-fg-subtle" aria-hidden="true" />
          {/if}
          <!-- Phones get 16px inputs: iOS Safari zooms the page on focus below that. -->
          <input
            bind:this={emailInputs[i]}
            type="email"
            value={row.email}
            oninput={(e) => set(i, { email: e.currentTarget.value })}
            onblur={() => row.email !== row.email.trim().toLowerCase() && set(i, { email: row.email.trim().toLowerCase() })}
            onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), amountInputs[i]?.focus())}
            autocomplete="off"
            spellcheck="false"
            {disabled}
            aria-label="Recipient {i + 1} email"
            aria-invalid={badEmail}
            aria-describedby={p || hint ? `${uid}-note-${i}` : undefined}
            placeholder="name@gmail.com"
            class="-mx-1.5 min-w-0 flex-1 rounded bg-transparent px-1.5 py-1 font-mono text-base text-zen-fg focus:outline-none focus:ring-1 focus:ring-zen-fg/30 sm:text-xs {badEmail ? 'text-zen-error' : ''}"
          />
        </div>
        <input
          bind:this={amountInputs[i]}
          type="text"
          inputmode="decimal"
          value={row.amount}
          oninput={(e) => set(i, { amount: e.currentTarget.value })}
          onkeydown={(e) => onAmountKey(e, i)}
          {disabled}
          aria-label="Recipient {i + 1} amount"
          aria-invalid={badAmount}
          aria-describedby={badAmount ? `${uid}-note-${i}` : undefined}
          placeholder="0"
          class="h-8 w-full rounded-lg border bg-zen-fg/[0.03] px-2.5 text-right font-mono text-base tabular-nums text-zen-fg focus:border-zen-fg/40 focus:outline-none sm:text-xs {badAmount ? 'border-zen-error/40 text-zen-error' : 'border-zen-border'}"
        />
        {#if rows.length > 1 || !isBlankRow(row)}
          <button
            type="button"
            onclick={() => remove(i)}
            {disabled}
            aria-label="Remove recipient {i + 1}"
            class="flex h-8 w-8 items-center justify-center rounded text-zen-fg-faint transition-colors hover:bg-zen-error/10 hover:text-zen-error"
          >
            <Trash2 class="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        {:else}<span></span>{/if}
        {#if p}
          <p id="{uid}-note-{i}" class="col-start-2 col-span-3 text-xs text-zen-error">{p.message}</p>
        {:else if hint}
          <p id="{uid}-note-{i}" class="col-start-2 col-span-3 flex items-center gap-1.5 text-xs text-zen-fg-subtle"><Info class="h-3 w-3 shrink-0" aria-hidden="true" />May not sign in with Google</p>
        {/if}
      </li>
    {/each}
  </ul>
</div>

<div class="flex flex-wrap items-center gap-6 px-1" aria-live="polite">
  <div>
    <span class="block text-[10px] uppercase tracking-wider text-zen-fg-muted">Recipients</span>
    <span class="text-lg font-semibold tabular-nums text-zen-fg">{count}</span>
  </div>
  <div>
    <span class="block text-[10px] uppercase tracking-wider text-zen-fg-muted">Total</span>
    <span class="text-lg font-semibold tabular-nums text-zen-fg">{formatAmount(total)} <span class="text-xs font-normal text-zen-fg-subtle">{unit}</span></span>
  </div>
</div>
