<script lang="ts">
  // Hero after the main repo's landing (packages/ui/lib/components/landing/Hero.svelte): same eyebrow,
  // headline, CTA and status classes. Grain lives only in the hero; nothing is drawn behind the text.
  import { ArrowRight } from 'lucide-svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';

  const TRY_URL = 'https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try';
</script>

<svelte:head><title>Zarf: send tokens to an email</title></svelte:head>

<section class="relative w-full min-h-[calc(100vh-4rem)] flex flex-col items-center justify-center overflow-hidden">
  <div class="landing-grain absolute inset-0 pointer-events-none z-0" aria-hidden="true"></div>

  <div class="relative z-10 text-center max-w-4xl px-6 flex flex-col items-center gap-5 md:gap-6">
    <span
      class="inline-flex items-center gap-2 rounded-full border border-zen-fg/10 bg-zen-fg/[0.04] backdrop-blur-md pl-3.5 pr-4 py-1.5"
    >
      <span class="text-[10px] font-semibold tracking-[0.28em] uppercase text-zen-fg/55">Built on NEAR</span>
    </span>

    <h1 class="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tighter text-zen-fg leading-[1.12] [text-wrap:balance]">
      Send tokens to an email.
    </h1>

    <p class="text-base md:text-lg text-zen-fg/60 max-w-xl text-center leading-normal">
      They claim with Google. The email never goes on chain.
    </p>

    <div class="flex flex-col sm:flex-row items-center gap-4 mt-6 w-full sm:w-auto">
      <a href={TRY_URL} class="inline-block w-full sm:w-auto no-underline">
        <ZenButton
          variant="primary"
          size="lg"
          class="rounded-full !bg-zen-fg/90 backdrop-blur-sm !text-zen-bg hover:shadow-lg hover:shadow-zen-fg/10 w-full sm:w-auto"
        >
          Try it with your Gmail
          {#snippet iconRight()}<ArrowRight class="w-3.5 h-3.5" />{/snippet}
        </ZenButton>
      </a>
      <a href="/create" class="inline-block w-full sm:w-auto no-underline">
        <ZenButton
          variant="secondary"
          size="lg"
          class="rounded-full !bg-zen-fg/5 backdrop-blur-md !text-zen-fg/80 !border-zen-fg/10 w-full sm:w-auto"
        >
          Send USDC
        </ZenButton>
      </a>
    </div>

    <p class="inline-flex items-center gap-1.5 text-[11px] font-medium tracking-[0.15em] uppercase text-zen-fg/35">
      Live on <span class="text-zen-fg/55">NEAR testnet</span>
    </p>
  </div>
</section>
