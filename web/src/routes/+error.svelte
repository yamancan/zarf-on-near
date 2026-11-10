<script lang="ts">
  // After the main claim app's +error.svelte: icon + mono status, one title, one line, one way home.
  import { page } from '$app/state';
  import { AlertTriangle } from 'lucide-svelte';
</script>

<svelte:head><title>Not found · Zarf</title></svelte:head>

<section class="flex flex-col items-center justify-center min-h-[60vh] gap-5 text-center px-6">
  <div class="flex items-center gap-3 text-zen-fg-muted">
    <AlertTriangle class="w-5 h-5" aria-hidden="true" />
    <span class="text-xs font-mono uppercase tracking-widest">Error {page.status}</span>
  </div>
  {#if page.status === 404}
    <h1 class="text-3xl font-semibold tracking-tight">This page does not exist</h1>
    <p class="max-w-md text-sm text-zen-fg-muted">If you followed a claim link, open it again from the message you received, in full.</p>
  {:else}
    <h1 class="text-3xl font-semibold tracking-tight">Something went wrong</h1>
    <p class="max-w-md text-sm text-zen-fg-muted">Try again in a minute. If you followed a claim link, open it again from the message you received.</p>
  {/if}
  <a href="/" class="inline-flex items-center min-h-11 px-6 rounded-full text-sm font-semibold no-underline bg-zen-btn-primary-bg text-zen-btn-primary-text hover:bg-zen-btn-primary-bg-hover transition-colors">What is Zarf?</a>
</section>
