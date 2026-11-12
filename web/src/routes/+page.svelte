<script lang="ts">
  // Landing: the Zarf landing page (main repo apps/landing/src/routes/+page.svelte) section for section: one fixed grain
  // layer, the hero, How It Works (sticky, copied), the final call to action (copied). Words say what Zarf on NEAR does.
  import Hero from '$lib/Hero.svelte';
  import HowItWorks from '$lib/landing/HowItWorks.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import { TESTNET, UNAUDITED_LINE } from '$lib/network';

  const TRY_URL = 'https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try';
</script>

<svelte:head><title>Zarf: Send Tokens to an Email</title></svelte:head>

<!-- main repo apps/landing +page.svelte:64-68: a fixed ground behind everything, one grain layer above it -->
<div class="fixed inset-0 bg-base-100 -z-10" aria-hidden="true"></div>
<div class="landing-grain fixed inset-0 pointer-events-none z-[25]" aria-hidden="true"></div>

<!-- Content lifted above the grain (main repo +page.svelte:128) -->
<div class="relative z-30">
  <Hero tryUrl={TRY_URL} />

  <HowItWorks />

  <!-- Final CTA: main repo +page.svelte:142-200, values unchanged -->
  <section class="py-24 relative overflow-hidden">
    <div class="container mx-auto px-6 max-w-2xl text-center">
      <p class="text-xs font-medium tracking-[0.2em] uppercase text-zen-fg-muted mb-4">{TESTNET ? 'Free on Testnet' : 'Start Now'}</p>
      <h2 class="text-3xl md:text-4xl font-semibold mb-5 tracking-tight text-base-content">Send Your First Link</h2>
      <p class="text-base text-zen-fg-muted mb-10 max-w-md mx-auto leading-relaxed">
        {TESTNET ? 'Claim 0.5 test USDC with your Google email, then send some to a friend.' : 'Pick emails and amounts, pay once in USDC.'}
      </p>
      <div class="flex flex-col sm:flex-row items-center justify-center gap-4">
        {#if TESTNET}
          <ZenButton href={TRY_URL} variant="primary" size="lg" class="rounded-full !bg-base-content !text-base-100 hover:shadow-lg hover:shadow-base-content/10 w-full sm:w-auto">Try with Google</ZenButton>
        {/if}
        <ZenButton href="/create" variant="secondary" size="lg" class="rounded-full w-full sm:w-auto">Send USDC</ZenButton>
      </div>
      <!-- T-001: the unaudited note stays visible on mainnet -->
      {#if !TESTNET}<p class="mt-10 text-xs text-zen-fg-muted max-w-md mx-auto">{UNAUDITED_LINE}</p>{/if}
    </div>

    <!-- Background Glow - more subtle (main repo +page.svelte:196-199) -->
    <div class="absolute bottom-0 left-1/2 -translate-x-1/2 w-[800px] h-[200px] bg-gradient-to-t from-base-content/3 to-transparent blur-[80px] -z-10" aria-hidden="true"></div>
  </section>
</div>
