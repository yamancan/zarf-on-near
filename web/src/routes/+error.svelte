<script lang="ts">
  // After the main claim app's +error.svelte: icon + mono status, one title, one line, one way home.
  import { page } from '$app/state';
  import { AlertTriangle, SearchX } from 'lucide-svelte';
  import Medallion from '$lib/Medallion.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';
</script>

<svelte:head><title>{page.status === 404 ? 'Page Not Found' : 'Error'} · Zarf</title></svelte:head>

<!-- The same terminal card as the claim states: medallion, title, one line, one way out -->
<div class="w-full max-w-lg mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12">
  <ZenCard variant="elevated" class="!rounded-3xl !p-6 sm:!p-8">
    <div class="flex flex-col items-center text-center space-y-6 py-2">
      {#if page.status === 404}
        <Medallion icon={SearchX} tone="muted" />
        <div class="space-y-2">
          <h1 class="text-xl font-bold">Page Not Found</h1>
          <p class="text-sm text-zen-fg-muted max-w-xs">Following a claim link? Open it in full from your message.</p>
        </div>
      {:else}
        <Medallion icon={AlertTriangle} tone="error" />
        <div class="space-y-2">
          <h1 class="text-xl font-bold">Something Went Wrong</h1>
          <p class="text-sm text-zen-fg-muted max-w-xs">Try again in a minute.</p>
        </div>
      {/if}
      <ZenButton href="/" variant="secondary">What Is Zarf?</ZenButton>
    </div>
  </ZenCard>
</div>
