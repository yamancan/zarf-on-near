<script lang="ts">
  // The amount, the way the claim card shows it (lib/ClaimCard.svelte amount row, T-033): the USDC mark, the number
  // large, the unit beside it. One treatment from "Claim" to "Arrived"; the label is for screen readers.
  import Mark from '$lib/Mark.svelte';
  import { MARKS } from '$lib/chains';
  let { label, value, unit = 'USDC' }: { label: string; value: string; unit?: string } = $props();
</script>

<div class="flex flex-wrap items-center gap-x-3 gap-y-1 min-w-0">
  <span class="sr-only">{label}</span>
  <Mark svg={MARKS.usdc} class="w-10 h-10" />
  <span class="text-5xl font-semibold tracking-tight text-zen-fg tabular-nums">{value}</span>
  <span class="text-base text-zen-fg-muted">{unit}</span>
</div>
