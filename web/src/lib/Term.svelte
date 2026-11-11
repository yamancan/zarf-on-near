<script lang="ts">
  // A term explained one layer down: the question a newcomer would ask, then the answer (the "Who sees the emails?" pattern).
  import type { Snippet } from 'svelte';
  import { ChevronDown } from 'lucide-svelte';
  let { q, children, class: cls = '' }: { q: string; children: Snippet; class?: string } = $props();
</script>

<details class="group text-sm text-zen-fg-muted {cls}">
  <summary class="inline-flex items-center gap-2 min-h-11 cursor-pointer list-none hover:text-zen-fg">
    {q}
    <ChevronDown class="w-4 h-4 shrink-0 transition-transform group-open:rotate-180" aria-hidden="true" />
  </summary>
  <p class="mb-2 max-w-prose">{@render children()}</p>
</details>
