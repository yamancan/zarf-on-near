<script lang="ts">
  // The one medallion: 64 px, icon 32 px, as in the main claim app (LoginPrompt, ClaimStep4Proof). Success is Zarf's
  // pair: bare success on success/10 (ClaimStep5Submit).
  import type { Mail } from 'lucide-svelte';
  let { icon: Icon, tone = 'primary', spin = false }: { icon: typeof Mail; tone?: 'primary' | 'success' | 'error' | 'muted'; spin?: boolean } = $props();
</script>

<div
  class="w-16 h-16 mx-auto rounded-full flex items-center justify-center shrink-0
    {tone === 'success' ? 'bg-zen-success/10 text-zen-success'
    : tone === 'error' ? 'bg-zen-error/5 text-zen-error border border-zen-error/10'
    : tone === 'muted' ? 'bg-zen-fg/5 text-zen-fg-muted border border-zen-border-subtle'
    : 'bg-zen-primary/10 text-zen-primary'}"
  aria-hidden="true"
>
  <Icon class="w-8 h-8 {spin ? 'animate-spin' : ''}" />
</div>
