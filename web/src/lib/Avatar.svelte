<script lang="ts">
  // The account's first letter in a 20 px circle (main repo DistributionCard token initial, design spec G6c).
  let { name }: { name: string } = $props();
</script>

<span class="inline-flex w-5 h-5 shrink-0 items-center justify-center rounded-full bg-zen-primary/5 ring-1 ring-zen-border-subtle text-[10px] font-semibold uppercase text-zen-primary" aria-hidden="true">{name.charAt(0) || '?'}</span>
