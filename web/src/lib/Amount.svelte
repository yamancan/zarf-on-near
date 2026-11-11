<script lang="ts">
  // The amount as the hero figure, as in the main claim app (ClaimStep5Submit): small uppercase label,
  // large light figure, unit beside it. The label uses fg-muted, not Zarf's fg-faint (2.2:1 fails as text).
  // `glow`: the two blurred circles of the main claim app's amount block (ClaimStep5Submit "Amount Highlight"),
  // same size, colour, blur and offsets, clipped to the block's padding and radius. Zarf's panel fill and border
  // are not ported: the amount block stays unboxed (canonical choice 4). Off where Zarf has none (create preview).
  let { label, value, unit = 'USDC', approx = false, struck = false, glow = true }: { label: string; value: string; unit?: string; approx?: boolean; struck?: boolean; glow?: boolean } = $props();
</script>

<span class="relative isolate flex flex-col items-center gap-1">
  {#if glow}
    <span class="absolute -inset-x-6 -inset-y-8 -z-10 overflow-hidden rounded-[2rem] pointer-events-none" aria-hidden="true">
      <span class="absolute -top-10 -right-10 w-32 h-32 bg-zen-primary/5 rounded-full blur-3xl"></span>
      <span class="absolute -bottom-10 -left-10 w-32 h-32 bg-zen-primary/5 rounded-full blur-3xl"></span>
    </span>
  {/if}
  <span class="text-[10px] uppercase tracking-[0.3em] text-zen-fg-muted font-bold">{label}</span>
  <span class="flex items-baseline justify-center gap-2 {struck ? 'line-through decoration-1 text-zen-fg-muted' : 'text-zen-fg'}">
    <span class="text-5xl font-light tracking-tighter tabular-nums">{#if approx}<span class="text-3xl mr-1 align-[0.2em]">≈</span>{/if}{value}</span>
    <span class="text-sm font-medium text-zen-primary uppercase tracking-widest whitespace-nowrap">{unit}</span>
  </span>
</span>
