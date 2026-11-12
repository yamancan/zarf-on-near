<script lang="ts">
  // "Amount Highlight" of the main claim app (ClaimStep5Submit:178-206), left-aligned, without its two blurred
  // circles (design spec G3). Label in fg-subtle: Zarf's fg-faint fails 4.5:1 as text.
  let { label, value, unit = 'USDC' }: { label: string; value: string; unit?: string } = $props();
</script>

<div class="relative py-8 px-6 rounded-[2rem] bg-zen-fg/5 border border-zen-border-subtle overflow-hidden">
  <div class="relative space-y-1">
    <span class="text-[10px] uppercase tracking-[0.3em] text-zen-fg-subtle font-bold">{label}</span>
    <div class="flex items-baseline justify-start gap-2">
      <span class="text-5xl font-light tracking-tighter text-zen-fg tabular-nums">{value}</span>
      <span class="text-sm font-medium text-zen-primary uppercase tracking-widest">{unit}</span>
    </div>
  </div>
</div>
