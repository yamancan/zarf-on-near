<script lang="ts">
  // After the main claim app's +error.svelte: icon + mono status, one title, one line, one way home.
  import { page } from '$app/state';
  import { AlertTriangle, SearchX } from 'lucide-svelte';
  import Medallion from '$lib/Medallion.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';
</script>

<svelte:head><title>{page.status === 404 ? 'Not found' : 'Error'} · Zarf</title></svelte:head>

<!-- The same terminal card as the claim states: medallion, title, one line, one way out -->
<div class="w-full max-w-lg mx-auto px-4 py-8 sm:py-14">
  <ZenCard variant="elevated" class="!p-6 sm:!p-8">
    <div class="flex flex-col items-center text-center gap-4 py-2">
      {#if page.status === 404}
        <Medallion icon={SearchX} tone="muted" />
        <h1 class="text-xl font-semibold tracking-tight">This page does not exist</h1>
        <p class="text-sm text-zen-fg-muted max-w-xs">Following a claim link? Open it again, in full, from your message.</p>
      {:else}
        <Medallion icon={AlertTriangle} tone="error" />
        <h1 class="text-xl font-semibold tracking-tight">Something went wrong</h1>
        <p class="text-sm text-zen-fg-muted max-w-xs">Try again in a minute. Following a claim link? Open it again from your message.</p>
      {/if}
      <ZenButton href="/" variant="secondary" class="rounded-full min-h-11 mt-2">What is Zarf?</ZenButton>
    </div>
  </ZenCard>
</div>
