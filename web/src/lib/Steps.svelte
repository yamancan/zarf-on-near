<script lang="ts">
  // The sender's progress list (Zarf's DeploymentPipeline anatomy): numbered rows, the current one marked, a
  // hairline connector, no boxes. Used by /create while sending and by the receipt while the claim settles.
  import type { Snippet } from 'svelte';
  import { Check, Clock, Loader2 } from 'lucide-svelte';
  type Row = { label: string; state: 'done' | 'active' | 'pending'; idle?: boolean };
  let { rows, label, detail }: { rows: Row[]; label: string; detail?: Snippet<[number, Row]> } = $props();
</script>

<ol class="flex flex-col" aria-label={label}>
  {#each rows as row, i (row.label)}
    <li class="relative flex gap-4 pb-5 last:pb-0 {row.state === 'pending' ? 'opacity-40' : ''}" aria-current={row.state === 'active' ? 'step' : undefined}>
      {#if i < rows.length - 1}<span class="absolute left-4 top-9 bottom-1 w-px bg-zen-border" aria-hidden="true"></span>{/if}
      <span class="w-8 h-8 shrink-0 rounded-full border-[0.5px] flex items-center justify-center text-xs font-medium
        {row.state === 'done' ? 'bg-zen-fg text-zen-bg border-zen-fg' : row.state === 'active' ? 'border-zen-border text-zen-fg' : 'border-zen-border-subtle text-zen-fg-muted'}">
        {#if row.state === 'done'}<Check class="w-4 h-4" aria-hidden="true" />{:else if row.state === 'active' && row.idle}<Clock class="w-4 h-4" aria-hidden="true" />{:else if row.state === 'active'}<Loader2 class="w-4 h-4 animate-spin" aria-hidden="true" />{:else}{i + 1}{/if}
      </span>
      <div class="flex flex-col min-w-0 pt-1.5">
        <span class="text-sm font-medium {row.state === 'active' ? 'text-zen-fg' : 'text-zen-fg-muted'}">{row.label}</span>
        {@render detail?.(i, row)}
      </div>
    </li>
  {/each}
</ol>
