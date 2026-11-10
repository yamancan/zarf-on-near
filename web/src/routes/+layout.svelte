<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import ZarfMark from '$lib/ZarfMark.svelte';
  import ThemeToggle from '$lib/zen/components/ThemeToggle.svelte';
  import ZenBadge from '$lib/zen/components/ZenBadge.svelte';
  import { themeStore } from '$lib/zen/stores/themeStore.svelte';

  let { children } = $props();
  // Pages already on Zen components lay themselves out; the others keep the narrow plain column.
  const zen = $derived(page.url.pathname === '/' || /^\/claim\/[^/]+\/[^/]+\/?$/.test(page.url.pathname));

  onMount(() => themeStore.restore());
</script>

<div class="min-h-screen font-sans bg-zen-bg text-zen-fg">
  <!-- ZarfNavbar (main repo), with the mark and lockup alone, no tile -->
  <header class="h-16 bg-zen-bg border-b-[0.5px] border-zen-border-subtle flex items-center justify-between px-4 sm:px-6 sticky top-0 z-50">
    <div class="flex items-center gap-3">
      <a href="/" class="flex items-center gap-2 opacity-80 hover:opacity-100 transition-opacity no-underline" aria-label="Zarf home">
        <ZarfMark size={14} />
        <span class="text-sm font-semibold tracking-tight">zarf.to</span>
      </a>
      <ZenBadge size="sm">NEAR</ZenBadge>
    </div>
    <div class="flex items-center gap-4">
      <a href="/privacy" class="text-xs text-zen-fg-subtle hover:text-zen-fg no-underline">Privacy</a>
      <div class="w-px h-4 bg-zen-border"></div>
      <ThemeToggle />
    </div>
  </header>

  {#if zen}
    <main id="main">{@render children()}</main>
  {:else}
    <main id="main" class="legacy max-w-md mx-auto px-4 py-8">{@render children()}</main>
  {/if}
</div>
