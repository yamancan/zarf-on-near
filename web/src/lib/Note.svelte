<script lang="ts">
  // One inline status line: icon plus text, never colour alone (main repo create step-0 error row).
  import type { Snippet } from 'svelte';
  import { AlertCircle, CheckCircle, Info, Loader2 } from 'lucide-svelte';
  let { tone = 'info', children, class: cls = '' }: { tone?: 'error' | 'success' | 'info' | 'pending'; children: Snippet; class?: string } = $props();
  const Icon = $derived({ error: AlertCircle, success: CheckCircle, info: Info, pending: Loader2 }[tone]);
</script>

<p
  class="flex items-start gap-2 text-sm font-medium text-left {tone === 'error' ? 'text-zen-error-content' : tone === 'success' ? 'text-zen-success-content' : 'text-zen-fg-muted'} {cls}"
  role={tone === 'error' ? 'alert' : 'status'}
>
  <Icon class="w-4 h-4 shrink-0 mt-0.5 {tone === 'pending' ? 'animate-spin' : ''}" aria-hidden="true" />
  <span class="min-w-0">{@render children()}</span>
</p>
