<script lang="ts">
  // The amount as a plain row under a hairline (T-023 waste list items 8, 9): the claim app's Amount Highlight type
  // (ClaimStep5Submit:178-206), without its box and without a visible eyebrow; the label is for screen readers.
  let { label, value, unit = 'USDC' }: { label: string; value: string; unit?: string } = $props();
</script>

<div class="pt-6 border-t border-zen-border-subtle">
  <span class="sr-only">{label}</span>
  <div class="flex items-baseline justify-start gap-2">
    <span class="text-5xl font-light tracking-tighter text-zen-fg tabular-nums">{value}</span>
    <span class="text-sm font-medium text-zen-primary uppercase tracking-widest">{unit}</span>
  </div>
</div>
