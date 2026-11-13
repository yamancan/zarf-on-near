<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { beforeNavigate } from '$app/navigation';
  import { TESTNET } from '$lib/network';
  import Mark from '$lib/Mark.svelte';
  import { MARKS } from '$lib/chains';
  import { brandName } from '$lib/text';
  import ZLockup from '$lib/zarf-kit/components/brand/ZLockup.svelte';
  import ThemeToggle from '$lib/zarf-kit/components/layout/ThemeToggle.svelte';
  import { themeStore } from '$lib/zarf-kit/stores/themeStore.svelte';

  let { children } = $props();
  const brand = brandName(location.hostname); // ssr=false: always in the browser
  let scrollY = $state(0);
  const NAV = [
    { href: '/create', label: 'Send' },
    { href: '/campaigns', label: 'Campaigns' },
  ];
  const landing = $derived(page.url.pathname === '/');
  // A recipient (claim, receipt, Google return) is not offered the sender's pages (canonical choice 1).
  // NEAR is named once per screen: this badge in the nav.
  const network = TESTNET ? 'NEAR Testnet' : 'NEAR';
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

{#snippet lockup()}
  <!-- The kit lockup (zarf-kit/components/brand/ZLockup): Zarf's ZarfLogo lg in the navbar (16 px) -->
  <ZLockup fontSize={16} label={brand} />
{/snippet}

<!-- Subtle ripple background texture (main repo apps/claim + apps/create +layout.svelte). Behind the page: the
     page wrapper below is lifted above it and leaves the ground to <html>, which carries the same --zen-bg. -->
<svelte:window bind:scrollY />

{#if !landing}<div class="ripple-bg" aria-hidden="true"></div>{/if}

<div class="min-h-screen {landing ? 'bg-zen-bg' : 'relative z-[1] overflow-x-clip'} text-zen-fg flex flex-col">
  <!-- ZarfNavbar (main repo): logo and nav on the left, actions on the right, solid ground, one hairline -->
  <!-- Landing: Zarf's landing header (transparent, blur and hairline once scrolled); elsewhere ZarfNavbar's solid bar -->
  {#if landing}
    <!-- Zarf's landing header (main repo apps/landing +page.svelte:70-125): transparent, blur and a hairline once scrolled;
         the network name (NEAR is named once per screen, here), the Follow pill, a divider, the theme toggle -->
    <header class="sticky top-0 w-full z-50 px-6 py-4 flex items-center justify-between transition-all duration-500 {scrollY > 20
      ? 'backdrop-blur-xl bg-base-100/70 border-b border-base-content/5'
      : 'backdrop-blur-none bg-transparent border-transparent'}">
      <a href="/" class="flex items-center gap-2.5" aria-label="{brand} home">{@render lockup()}</a>
      <div class="flex items-center gap-3">
        <span class="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-zen-fg-muted px-1.5"><Mark svg={MARKS.near} class="w-4 h-4" />{network}</span>
        <a href="https://x.com/zarfto" target="_blank" rel="noopener noreferrer" aria-label="Follow Zarf on X" class="inline-flex items-center gap-1.5 rounded-full bg-base-content/5 text-base-content/70 border border-base-content/8 hover:text-base-content hover:bg-base-content/10 px-4 py-1.5 text-xs font-medium transition-colors">
          <svg class="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
          </svg>
          <span class="hidden sm:inline">Follow</span>
        </a>
        <div class="hidden sm:block w-px h-5 bg-base-content/8" aria-hidden="true"></div>
        <ThemeToggle />
      </div>
    </header>
  {:else}
    <!-- ZarfNavbar (main repo packages/ui/lib/components/layout/ZarfNavbar.svelte): h-16, solid ground, 0.5 px hairline,
         lockup and nav on the left, X, divider and theme toggle on the right. NEAR adds the network name where Zarf
         has its wallet button, and keeps Send reachable on phones (critic P1-24) -->
    <header class="h-16 bg-zen-bg border-b-[0.5px] border-zen-border-subtle flex items-center justify-between gap-3 px-4 sm:px-6 sticky top-0 z-50">
      <div class="flex items-center gap-5 md:gap-8">
        <a href="/" class="group opacity-80 hover:opacity-100 transition-opacity" aria-label="{brand} home">{@render lockup()}</a>
        {#if !recipient}
          <nav class="flex items-center gap-4 md:gap-6" aria-label="Main">
            {#each NAV as n (n.href)}
              <a
                href={n.href}
                aria-current={page.url.pathname.startsWith(n.href) ? 'page' : undefined}
                class="text-xs font-medium transition-colors hover:text-zen-fg {page.url.pathname.startsWith(n.href) ? 'text-zen-fg' : 'text-zen-fg-muted'}">{n.label}</a
              >
            {/each}
          </nav>
        {/if}
      </div>
      <div class="flex items-center gap-4">
        <a href="https://x.com/zarfto" target="_blank" rel="noopener noreferrer" aria-label="Follow Zarf on X" class="hidden sm:inline-flex text-zen-fg-subtle hover:text-zen-fg transition-colors">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
          </svg>
        </a>
        <div class="hidden sm:block w-px h-4 bg-zen-border" aria-hidden="true"></div>
        <span class="inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium text-zen-fg-muted"><Mark svg={MARKS.near} class="w-4 h-4" />{network}</span>
        <div class="w-px h-4 bg-zen-border" aria-hidden="true"></div>
        <ThemeToggle />
      </div>
    </header>
  {/if}

  <main id="main" class="flex-1 flex flex-col">{@render children()}</main>

  <!-- Footer: the main repo landing's (apps/landing/src/routes/+page.svelte:204-270) frame and type. The lockup, X and
       "Built on NEAR" are not repeated here: the nav carries them. On phones the app nav hides X, so the footer has it. -->
  <footer class="relative mt-auto border-t border-base-content/5 overflow-hidden">
    <div class="container mx-auto px-6 py-10 relative z-10">
      <div class="flex flex-col md:flex-row justify-between items-center gap-5 text-xs font-medium text-zen-fg-muted">
        <div class="flex gap-6">
          <a href="/privacy" class="hover:text-base-content/70 transition-colors duration-300">Privacy</a>
          {#if !landing}
            <a href="https://x.com/zarfto" target="_blank" rel="noopener noreferrer" aria-label="Zarf on X" class="sm:hidden hover:text-base-content/70 transition-colors duration-300 flex items-center gap-1.5">
              <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"></path>
              </svg>
              X
            </a>
          {/if}
        </div>
        <div class="flex items-center gap-1.5">
          <span>© 2026</span>
          <a href="https://trionlabs.dev" target="_blank" rel="noopener noreferrer" class="hover:text-base-content/60 transition-colors duration-300">trionlabs.dev</a>
        </div>
      </div>
    </div>
  </footer>
</div>
