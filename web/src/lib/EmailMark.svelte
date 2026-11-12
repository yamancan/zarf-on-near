<script lang="ts">
  // Design spec G6a: Google's Gmail mark before a Gmail address, a plain mail icon before any other. Display only.
  import { Mail } from 'lucide-svelte';
  let { email }: { email: string } = $props();
  const gmail = $derived(/@(gmail|googlemail)\.com$/i.test(email.trim()));
</script>

{#if gmail}<img src="/google/gmail.svg" alt="" width="14" height="14" class="h-3.5 w-3.5 shrink-0" />{:else}<Mail class="h-3.5 w-3.5 shrink-0 text-zen-fg-subtle" aria-hidden="true" />{/if}
