<script lang="ts">
  // The amount as the hero figure, as in the main claim app (ClaimStep5Submit): small uppercase label,
  // large light figure, unit beside it. The label uses fg-muted, not Zarf's fg-faint (2.2:1 fails as text).
  // No glow: the design spec (G3) drops Zarf's two blurred circles.
  let { label, value, unit = 'USDC', approx = false, struck = false }: { label: string; value: string; unit?: string; approx?: boolean; struck?: boolean } = $props();
</script>

<span class="relative isolate flex flex-col items-center gap-1">
  <span class="text-[10px] uppercase tracking-[0.3em] text-zen-fg-muted font-bold">{label}</span>
  <span class="flex items-baseline justify-center gap-2 {struck ? 'line-through decoration-1 text-zen-fg-muted' : 'text-zen-fg'}">
    <span class="text-5xl font-light tracking-tighter tabular-nums">{#if approx}<span class="text-3xl mr-1 align-[0.2em]">≈</span>{/if}{value}</span>
    <span class="text-sm font-medium text-zen-primary uppercase tracking-widest whitespace-nowrap">{unit}</span>
  </span>
</span>
