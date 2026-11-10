<script lang="ts">
  // Landing: the main repo's hero (lib/Hero.svelte), then How it works in three steps, each a small piece
  // of the product. The texture belongs to the hero only; nothing is drawn behind the steps.
  import { Check, ChevronDown, Mail } from 'lucide-svelte';
  import Hero from '$lib/Hero.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import { themeStore } from '$lib/zen/stores/themeStore.svelte';

  const TRY_URL = 'https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try';
  const STEPS = [
    { title: 'Add emails and amounts', line: 'Fund them once from a NEAR wallet.' },
    { title: 'They claim with Google', line: 'Pick a NEAR account, then sign in with Google.' },
    { title: 'USDC arrives', line: 'On NEAR, or another chain via NEAR Intents.' },
  ];
</script>

<svelte:head><title>Zarf: send tokens to an email</title></svelte:head>

<Hero tryUrl={TRY_URL} />

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
            <div class="w-full max-w-[220px] flex flex-col items-center gap-2.5">
              <span class="text-3xl font-light tracking-tighter tabular-nums">10 <span class="text-xs font-medium uppercase tracking-widest text-zen-primary">USDC</span></span>
              <div class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border-[0.5px] border-zen-border">
                <span class="text-xs font-mono text-zen-fg/80">alice.testnet</span>
                <span class="flex items-center gap-1 text-[11px] text-zen-success-content"><Check class="w-3 h-3" />found</span>
              </div>
              <img src={themeStore.isDark ? '/google/signin-dark.svg' : '/google/signin-light.svg'} alt="" width="150" height="33" />
            </div>
          {:else}
            <div class="flex flex-col items-center gap-3">
              <Medallion icon={Check} tone="success" />
              <span class="text-3xl font-light tracking-tighter tabular-nums">+10 <span class="text-xs font-medium uppercase tracking-widest text-zen-primary">USDC</span></span>
              <span class="text-xs font-mono text-zen-fg-muted">alice.testnet</span>
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
