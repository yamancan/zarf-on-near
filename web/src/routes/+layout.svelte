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
  let scrollY = $state(0);
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
    <ZarfMark size={small ? 11 : 12} />zarf.to
  </span>
{/snippet}

<!-- Subtle ripple background texture (main repo apps/claim + apps/create +layout.svelte). Behind the page: the
     page wrapper below is lifted above it and leaves the ground to <html>, which carries the same --zen-bg. -->
<svelte:window bind:scrollY />

{#if !landing}<div class="ripple-bg" aria-hidden="true"></div>{/if}

<div class="min-h-screen {landing ? 'font-sans bg-zen-bg' : 'font-app relative z-[1] overflow-x-clip'} text-zen-fg flex flex-col">
  <!-- ZarfNavbar (main repo): logo and nav on the left, actions on the right, solid ground, one hairline -->
  <!-- Landing: Zarf's landing header (transparent, blur and hairline once scrolled); elsewhere ZarfNavbar's solid bar -->
  <header class="h-16 flex items-center justify-between gap-3 px-4 sm:px-6 sticky top-0 z-50 transition-all duration-500
    {!landing ? 'bg-zen-bg border-b-[0.5px] border-zen-border-subtle' : scrollY > 20 ? 'backdrop-blur-xl bg-base-100/70 border-b border-base-content/5' : 'bg-transparent border-b border-transparent'}">
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
        <span class="whitespace-nowrap text-[10px] font-medium uppercase tracking-[0.15em] text-zen-fg-subtle">NEAR Testnet</span>
      {/if}
      {#if landing}
        <!-- Zarf landing header's Follow pill -->
        <a href="https://x.com/zarfto" target="_blank" rel="noopener noreferrer" aria-label="Follow Zarf on X" class="inline-flex items-center gap-1.5 rounded-full bg-base-content/5 text-base-content/70 border border-base-content/8 hover:text-base-content hover:bg-base-content/10 px-4 py-1.5 text-xs font-medium transition-colors">
          <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
          </svg>
          <span class="hidden sm:inline">Follow</span>
        </a>
      {:else}
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
      {/if}
      <div class="hidden sm:block w-px h-4 bg-zen-border" aria-hidden="true"></div>
      <ThemeToggle />
    </div>
  </header>

  <main id="main" class="flex-1 flex flex-col">{@render children()}</main>

  <!-- Footer: the main repo landing's (apps/landing/src/routes/+page.svelte:204-270) verbatim; swaps only: NEAR
       lockup, Privacy for Docs, no GitHub until the repo is public, NEAR for Stellar -->
  <footer class="relative mt-auto border-t border-base-content/5 overflow-hidden">
    <div class="container mx-auto px-6 py-10 relative z-10">
      <div class="flex flex-col md:flex-row justify-between items-center gap-5">
        <a href="/" class="flex items-center gap-2 text-zen-fg-muted hover:text-base-content/60 transition-colors duration-300" aria-label="zarf.to home">
          {@render lockup(true)}
        </a>

        <div class="flex gap-6 text-xs font-medium text-zen-fg-muted">
          <a href="/privacy" class="hover:text-base-content/70 transition-colors duration-300">Privacy</a>
          <a href="https://x.com/zarfto" target="_blank" rel="noopener noreferrer" aria-label="Zarf on X" class="hover:text-base-content/70 transition-colors duration-300 flex items-center gap-1.5">
            <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
            </svg>
            X
          </a>
        </div>

        <div class="text-xs text-zen-fg-muted flex items-center gap-1.5">
          <span>© 2026</span>
          <span class="text-base-content/20">·</span>
          <span>Built on</span>
          <a href="https://near.org" target="_blank" rel="noopener noreferrer" class="text-zen-fg-muted hover:text-base-content/60 transition-colors duration-300 inline-flex items-center gap-1">
            <!-- NEAR mark (simple-icons 13.21.0 near.svg) -->
            <svg class="w-3 h-3 fill-current" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21.443 0c-.89 0-1.714.46-2.18 1.218l-5.017 7.448a.533.533 0 0 0 .792.7l4.938-4.282a.2.2 0 0 1 .334.151v13.41a.2.2 0 0 1-.354.128L5.03.905A2.555 2.555 0 0 0 3.078 0h-.521A2.557 2.557 0 0 0 0 2.557v18.886a2.557 2.557 0 0 0 4.736 1.338l5.017-7.448a.533.533 0 0 0-.792-.7l-4.938 4.283a.2.2 0 0 1-.333-.152V5.352a.2.2 0 0 1 .354-.128l14.924 17.87c.486.574 1.2.905 1.952.906h.521A2.558 2.558 0 0 0 24 21.445V2.557A2.558 2.558 0 0 0 21.443 0Z"></path>
            </svg>
            NEAR</a
          >
          <span>by</span>
          <a href="https://trionlabs.dev" target="_blank" rel="noopener noreferrer" class="text-zen-fg-muted hover:text-base-content/60 transition-colors duration-300">trionlabs.dev</a>
        </div>
      </div>
    </div>
  </footer>
</div>
