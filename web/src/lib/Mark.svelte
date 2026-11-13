<script lang="ts">
  // One of our own inline SVG marks (lib/chains.ts MARKS or a chain logo), decorative: the text beside it names it.
  import { markLogo } from '$lib/chains';
  let { svg, class: cls = 'w-4 h-4' }: { svg: string; class?: string } = $props();
  const html = $derived(markLogo(svg));
</script>

<span class="inline-flex shrink-0 [&>svg]:w-full [&>svg]:h-full {cls}" aria-hidden="true">{@html html}</span>
