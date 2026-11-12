<script lang="ts">
  // One layer down for a cross-chain payout that did not arrive: the deposit address (public, copyable: the
  // sender gives it to NEAR Intents support) and any line the surface leaves out.
  import { ChevronDown } from 'lucide-svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';

  let { depositAddress, lines = [] }: { depositAddress: string; lines?: string[] } = $props();
  let copied = $state(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(depositAddress);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // clipboard blocked: the address stays selectable on the page
    }
  }
</script>

<details class="group w-full text-xs text-zen-fg-muted">
  <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
  <div class="flex flex-col items-center gap-1">
    {#each lines.filter(Boolean) as line}<p class="break-words max-w-xs">{line}</p>{/each}
    <p>Bridge deposit address</p>
    <p class="font-mono break-all select-all text-zen-fg">{depositAddress}</p>
    <ZenButton variant="ghost" size="sm" onclick={copy} aria-live="polite">{copied ? 'Copied' : 'Copy Address'}</ZenButton>
  </div>
</details>
