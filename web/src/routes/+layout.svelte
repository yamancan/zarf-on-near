<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { beforeNavigate } from '$app/navigation';
  import { TESTNET } from '$lib/network';
  import ZarfMark from '$lib/ZarfMark.svelte';
  import ThemeToggle from '$lib/zen/components/ThemeToggle.svelte';
  import { themeStore } from '$lib/zen/stores/themeStore.svelte';

  let { children } = $props();
  const NAV = [
    { href: '/create', label: 'Send' },
    { href: '/campaigns', label: 'Campaigns' },
  ];
  const landing = $derived(page.url.pathname === '/');
  // A recipient (claim, receipt, Google return) is not offered the sender's pages (canonical choice 1).
  const recipient = $derived(/^\/(claim|auth)\//.test(page.url.pathname));

  onMount(() => themeStore.restore());

  // The CSP comes with the document. The wallet pages' CSP lets wallet code connect out (hooks.server.ts isWalletPage);
  // every other page's does not. Crossing between the two loads a fresh document, so each page runs under its own CSP.
  const sender = (path: string) => /^\/(create|campaigns)(\/|$)|^\/claim\/[^/]+\/[^/]+\/?$/.test(path);
  beforeNavigate((nav) => {
    if (!nav.to || nav.willUnload || nav.to.url.origin !== location.origin) return;
    if (sender(nav.to.url.pathname) !== sender(location.pathname)) {
      nav.cancel();
      location.href = nav.to.url.href;
    }
  });
</script>

{#snippet lockup(small: boolean)}
  <!-- Brand kit lockup: the mark as tall as the "f" of zarf.to; ink gap mark→"z" 0.4x the mark (the "z" side
       bearing and the mark's own edge add about 2 px to the box gap, measured from renders) -->
  <span class="flex items-center {small ? 'gap-[2px] text-xs' : 'gap-[3px] text-base'} font-semibold tracking-tight">
    <ZarfMark size={small ? 9 : 12} />zarf.to
  </span>
{/snippet}

<!-- Subtle ripple background texture (main repo apps/claim + apps/create +layout.svelte). Behind the page: the
     page wrapper below is lifted above it and leaves the ground to <html>, which carries the same --zen-bg. -->
{#if !landing}<div class="ripple-bg" aria-hidden="true"></div>{/if}

<div class="min-h-screen {landing ? 'font-sans bg-zen-bg' : 'font-app relative z-[1] overflow-x-clip'} text-zen-fg flex flex-col">
  <!-- ZarfNavbar (main repo): logo and nav on the left, actions on the right, solid ground, one hairline -->
  <header class="h-16 bg-zen-bg border-b-[0.5px] border-zen-border-subtle flex items-center justify-between gap-3 px-4 sm:px-6 sticky top-0 z-50">
    <div class="flex items-center gap-4 sm:gap-5 md:gap-8">
      <a href="/" class="group flex items-center min-h-11 opacity-80 hover:opacity-100 transition-opacity" aria-label="zarf.to home">
        {@render lockup(false)}
      </a>
      <!-- Zarf hides the nav below md; here Send stays reachable on phones (critic P1-24), but not for recipients -->
      {#if !recipient}
      <nav class="flex items-center gap-3 sm:gap-4 md:gap-6" aria-label="Main">
        {#each NAV as n (n.href)}
          <a
            href={n.href}
            aria-current={page.url.pathname.startsWith(n.href) ? 'page' : undefined}
            class="inline-flex items-center min-h-11 text-xs font-medium transition-colors
              {page.url.pathname.startsWith(n.href) ? 'text-zen-fg' : 'text-zen-fg-muted hover:text-zen-fg'}">{n.label}</a
          >
        {/each}
      </nav>
      {/if}
    </div>
    <div class="flex items-center gap-3 sm:gap-4">
      {#if TESTNET}
        <span class="whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted">NEAR testnet</span>
      {/if}
      <a
        href="https://x.com/zarfto"
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Follow Zarf on X"
        class="hidden sm:inline-flex items-center justify-center min-h-11 text-zen-fg-subtle hover:text-zen-fg transition-colors"
      >
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
        </svg>
      </a>
      <div class="hidden sm:block w-px h-4 bg-zen-border" aria-hidden="true"></div>
      <ThemeToggle />
    </div>
  </header>

  <main id="main" class="flex-1 flex flex-col">{@render children()}</main>

  <!-- Footer (main repo landing): wordmark, links, built-on line -->
  <footer class="relative border-t border-zen-fg/5">
    <div class="max-w-5xl mx-auto px-6 py-10 flex flex-col md:flex-row justify-between items-center gap-5">
      <a href="/" class="flex items-center min-h-11 text-zen-fg-muted hover:text-zen-fg transition-colors" aria-label="zarf.to home">
        {@render lockup(true)}
      </a>
      <div class="flex gap-6 text-xs font-medium text-zen-fg-muted">
        <a href="/create" class="inline-flex items-center min-h-11 hover:text-zen-fg transition-colors">Send</a>
        <a href="/campaigns" class="inline-flex items-center min-h-11 hover:text-zen-fg transition-colors">Campaigns</a>
        <a href="/privacy" class="inline-flex items-center min-h-11 hover:text-zen-fg transition-colors">Privacy</a>
      </div>
      <div class="text-xs text-zen-fg-muted flex items-center gap-1.5">
        <span>© 2026</span>
        <span class="text-zen-fg/20" aria-hidden="true">·</span>
        <span>Built on NEAR by</span>
        <a href="https://trionlabs.dev" target="_blank" rel="noopener noreferrer" class="inline-flex items-center min-h-11 hover:text-zen-fg transition-colors">trionlabs.dev</a>
      </div>
    </div>
  </footer>
</div>
