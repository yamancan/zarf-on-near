<script lang="ts">
  // Hero after the main repo's landing (packages/ui/lib/components/landing/Hero.svelte): same eyebrow,
  // headline, CTA and status classes. Grain lives only in the hero; nothing is drawn behind the text.
  import { ArrowRight, Check, ChevronDown, Mail } from 'lucide-svelte';
  import ZarfMark from '$lib/ZarfMark.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import { themeStore } from '$lib/zen/stores/themeStore.svelte';

  const TRY_URL = 'https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try';
  const STEPS = [
    { title: 'Add emails and amounts', line: 'Fund them once from a NEAR wallet.' },
    { title: 'They sign in with Google', line: 'One link, one Google sign-in. No wallet to start.' },
    { title: 'USDC arrives', line: 'On NEAR, or another chain via NEAR Intents.' },
  ];
</script>

<svelte:head><title>Zarf: send tokens to an email</title></svelte:head>

<section class="relative w-full min-h-[calc(100svh-12rem)] flex flex-col items-center justify-center overflow-hidden">
  <!-- the mask only fades the grain out at the bottom edge, so the hero has no hard seam -->
  <div class="landing-grain absolute inset-0 pointer-events-none z-0 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" aria-hidden="true"></div>

  <div class="relative z-10 text-center max-w-4xl px-6 py-16 flex flex-col items-center gap-5 md:gap-6">
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

<!-- How it works: three steps, each shown as a small piece of the product (main repo HowItWorks scenes, static) -->
<section class="w-full max-w-5xl mx-auto px-6 pt-10 pb-20 md:pt-16 md:pb-28" aria-labelledby="how">
  <h2 id="how" class="text-[11px] font-medium tracking-[0.15em] uppercase text-zen-fg-muted text-center mb-10 md:mb-14">How it works</h2>

  <ol class="grid gap-12 md:grid-cols-3 md:gap-8">
    {#each STEPS as s, i (s.title)}
      <li class="flex flex-col gap-5">
        <div class="relative aspect-[16/10] md:aspect-[4/3] rounded-2xl bg-zen-bg-elevated border-[0.5px] border-zen-border-subtle overflow-hidden flex items-center justify-center p-6" aria-hidden="true">
          {#if i === 0}
            <div class="w-full max-w-[220px] flex flex-col gap-2">
              {#each [['alice@gmail.com', '10'], ['bob@gmail.com', '2.5'], ['chen@gmail.com', '25']] as [e, a] (e)}
                <div class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-zen-fg/[0.03] border-[0.5px] border-zen-border-subtle">
                  <Mail class="w-3.5 h-3.5 text-zen-fg-muted shrink-0" />
                  <span class="flex-1 text-xs text-zen-fg/80 truncate">{e}</span>
                  <span class="text-xs font-semibold tabular-nums">{a}</span>
                </div>
              {/each}
            </div>
          {:else if i === 1}
            <div class="flex flex-col items-center gap-3">
              <div class="w-10 h-10 rounded-full bg-zen-primary/10 text-zen-primary flex items-center justify-center"><Mail class="w-5 h-5" /></div>
              <span class="text-3xl font-bold tracking-tighter tabular-nums">10 USDC</span>
              <img src={themeStore.isDark ? '/google/signin-dark.svg' : '/google/signin-light.svg'} alt="" width="150" height="33" />
            </div>
          {:else}
            <div class="flex flex-col items-center gap-3">
              <div class="w-10 h-10 rounded-full bg-zen-success/10 text-zen-success border border-zen-success/10 flex items-center justify-center"><Check class="w-5 h-5" /></div>
              <span class="text-3xl font-bold tracking-tighter tabular-nums text-zen-success">+10 USDC</span>
              <span class="text-xs font-mono text-zen-fg-muted">alice.near</span>
            </div>
          {/if}
        </div>
        <div class="flex gap-3">
          <span class="font-mono text-[11px] text-zen-fg-muted pt-1">0{i + 1}</span>
          <div class="flex flex-col gap-1">
            <h3 class="text-base font-semibold tracking-tight">{s.title}</h3>
            <p class="text-sm text-zen-fg-muted">{s.line}</p>
          </div>
        </div>
      </li>
    {/each}
  </ol>

  <details class="mt-14 mx-auto max-w-xl text-center text-sm text-zen-fg-muted group">
    <summary class="inline-flex items-center gap-2 min-h-11 cursor-pointer list-none hover:text-zen-fg">
      Who sees the email?
      <ChevronDown class="w-4 h-4 transition-transform group-open:rotate-180" aria-hidden="true" />
    </summary>
    <p class="mt-2 text-left sm:text-center">
      The email never goes on chain. Our verifier, operated by Trion Labs, sees it once when you claim, to check it
      matches the link, and does not store it. On testnet the USDC is a test token with no value.
    </p>
  </details>
</section>

<footer class="border-t-[0.5px] border-zen-border-subtle">
  <div class="max-w-5xl mx-auto px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-zen-fg-muted">
    <span class="flex items-center gap-2"><ZarfMark size={14} /> Zarf by Trion Labs</span>
    <span class="flex gap-5">
      <a href="/create" class="no-underline hover:text-zen-fg text-zen-fg-muted">Send</a>
      <a href="/campaigns" class="no-underline hover:text-zen-fg text-zen-fg-muted">Campaigns</a>
      <a href="/privacy" class="no-underline hover:text-zen-fg text-zen-fg-muted">Privacy</a>
    </span>
  </div>
</footer>
