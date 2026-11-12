<script lang="ts">
  // One inline status line: icon plus text, never colour alone (main repo create step-0 error row).
  // `center`: inside a centred card the icon sits inline before the first word, so the line centres as one.
  import type { Snippet } from 'svelte';
  import { AlertCircle, CheckCircle, Info, Loader2 } from 'lucide-svelte';
  let { tone = 'info', center = false, children, class: cls = '' }: { tone?: 'error' | 'success' | 'info' | 'pending'; center?: boolean; children: Snippet; class?: string } = $props();
  const Icon = $derived({ error: AlertCircle, success: CheckCircle, info: Info, pending: Loader2 }[tone]);
  const color = $derived(tone === 'error' ? 'text-zen-error' : tone === 'success' ? 'text-zen-success' : 'text-zen-fg-muted');
</script>

{#if center}
  <p class="text-sm font-medium text-center max-w-xs {color} {cls}" role={tone === 'error' ? 'alert' : 'status'}>
    <Icon class="inline-block w-4 h-4 mr-1 -mt-0.5 align-middle {tone === 'pending' ? 'animate-spin' : ''}" aria-hidden="true" />{@render children()}
  </p>
{:else}
  <p class="flex items-start gap-2 text-sm font-medium text-left {color} {cls}" role={tone === 'error' ? 'alert' : 'status'}>
    <Icon class="w-4 h-4 shrink-0 mt-0.5 {tone === 'pending' ? 'animate-spin' : ''}" aria-hidden="true" />
    <span class="min-w-0">{@render children()}</span>
  </p>
{/if}
