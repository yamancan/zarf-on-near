<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import ZarfMark from '$lib/ZarfMark.svelte';
  import ThemeToggle from '$lib/zen/components/ThemeToggle.svelte';
  import ZenBadge from '$lib/zen/components/ZenBadge.svelte';
  import { themeStore } from '$lib/zen/stores/themeStore.svelte';

  let { children } = $props();
  const NAV = [
    { href: '/create', label: 'Send', wide: true },
    { href: '/campaigns', label: 'Campaigns', wide: true },
    { href: '/privacy', label: 'Privacy', wide: false },
  ];

  onMount(() => themeStore.restore());
</script>

<div class="min-h-screen font-sans bg-zen-bg text-zen-fg flex flex-col">
  <!-- ZarfNavbar (main repo), with the mark alone, no tile; sized to read like zarf.to's lockup -->
  <header class="h-16 bg-zen-bg/80 backdrop-blur-xl border-b-[0.5px] border-zen-border-subtle flex items-center justify-between px-4 sm:px-6 sticky top-0 z-50">
    <div class="flex items-center gap-3">
      <a href="/" class="flex items-center gap-2 min-h-11 opacity-90 hover:opacity-100 transition-opacity no-underline" aria-label="Zarf home">
        <ZarfMark size={18} />
        <span class="text-base font-semibold tracking-tight">zarf.to</span>
      </a>
      <ZenBadge size="sm">NEAR</ZenBadge>
    </div>
    <nav class="flex items-center gap-1 sm:gap-2" aria-label="Main">
      {#each NAV as n (n.href)}
        <a
          href={n.href}
          aria-current={page.url.pathname.startsWith(n.href) ? 'page' : undefined}
          class="{n.wide ? 'hidden sm:inline-flex' : 'inline-flex'} items-center min-h-11 px-2 text-xs font-medium tracking-wide no-underline transition-colors
            {page.url.pathname.startsWith(n.href) ? 'text-zen-fg' : 'text-zen-fg-muted hover:text-zen-fg'}">{n.label}</a
        >
      {/each}
      <div class="w-px h-4 bg-zen-border mx-1" aria-hidden="true"></div>
      <ThemeToggle />
    </nav>
  </header>

  <main id="main" class="flex-1 flex flex-col">{@render children()}</main>
</div>
