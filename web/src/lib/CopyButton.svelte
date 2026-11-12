<script lang="ts">
  // Design spec G6d: a ghost icon button after a link, account, address or token id; Check + "Copied" for 1.5 s.
  import { Check, Copy } from 'lucide-svelte';
  let { value, label = 'Copy' }: { value: string | (() => string); label?: string } = $props();
  let copied = $state(false);
  async function copy() {
    await navigator.clipboard.writeText(typeof value === 'function' ? value() : value);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }
</script>

<button type="button" class="inline-flex items-center gap-1 h-7 px-1.5 rounded-full text-xs text-zen-fg-subtle hover:text-zen-fg hover:bg-zen-fg/5 transition-colors shrink-0" aria-label={copied ? 'Copied' : label} onclick={copy}>
  {#if copied}<Check class="w-3.5 h-3.5" aria-hidden="true" /><span>Copied</span>{:else}<Copy class="w-3.5 h-3.5" aria-hidden="true" />{/if}
</button>
