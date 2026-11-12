<script lang="ts">
  // Landing (design spec 3.5): the main repo's hero (lib/Hero.svelte), then How It Works in three steps, each a
  // small piece of the product. One fixed grain layer for the whole page, as zarf.to.
  import { Check, Mail } from 'lucide-svelte';
  import Hero from '$lib/Hero.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import GoogleG from '$lib/GoogleG.svelte';
  import { TESTNET, UNAUDITED_LINE, UNIT } from '$lib/network';

  const TRY_URL = 'https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try';
  const STEPS = [
    { title: 'Add Emails and Amounts', line: 'Pay once in USDC from a NEAR wallet.' },
    { title: 'They Claim with Google', line: 'Pick a NEAR account, then sign in.' },
    { title: TESTNET ? 'Test USDC Arrives' : 'USDC Arrives', line: 'On NEAR, or on another chain on mainnet.' },
  ];
</script>

<svelte:head><title>Zarf: Send Tokens to an Email</title></svelte:head>

<!-- main repo apps/landing +page.svelte:68 -->
<div class="landing-grain fixed inset-0 pointer-events-none z-[25]" aria-hidden="true"></div>

<Hero tryUrl={TRY_URL} />

<!-- How It Works: no card frames; each step is the mock object (framed), its number, a title and one line -->
<section class="w-full max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-24" aria-labelledby="how">
  <h2 id="how" class="zen-section-label !text-zen-fg-subtle text-center !mb-12">How It Works</h2>

  <ol class="grid gap-12 md:grid-cols-3 md:gap-8">
    {#each STEPS as s, i (s.title)}
      <li class="flex flex-col gap-5">
        <div class="relative aspect-[16/10] md:aspect-[4/3] rounded-2xl bg-zen-bg-elevated border border-zen-border-subtle overflow-hidden flex items-center justify-center p-6" aria-hidden="true">
          {#if i === 0}
            <div class="w-full max-w-[240px] flex flex-col gap-2">
              {#each [['alice@gmail.com', '10'], ['bob@gmail.com', '2.5'], ['chen@gmail.com', '25']] as [e, a] (e)}
                <div class="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-zen-fg/[0.03] border border-zen-border-subtle">
                  <img src="/google/gmail.svg" alt="" width="14" height="14" class="h-3.5 w-3.5 shrink-0" />
                  <span class="flex-1 text-xs text-zen-fg/80 truncate">{e}</span>
                  <span class="text-xs font-semibold tabular-nums whitespace-nowrap">{a}</span>
                </div>
              {/each}
            </div>
          {:else if i === 1}
            <div class="w-full max-w-[220px] flex flex-col items-center gap-2.5">
              <span class="text-3xl font-light tracking-tighter tabular-nums">10 <span class="text-xs font-medium uppercase tracking-widest text-zen-primary">{UNIT}</span></span>
              <div class="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg border border-zen-border">
                <span class="text-xs font-mono text-zen-fg/80">alice.testnet</span>
                <Check class="w-3.5 h-3.5 text-zen-success" />
              </div>
              <span class="w-full flex items-center justify-center rounded-full bg-zen-fg text-zen-bg text-xs font-medium h-9"><GoogleG />Sign in with Google</span>
            </div>
          {:else}
            <div class="flex flex-col items-center gap-3">
              <Medallion icon={Check} tone="success" />
              <span class="text-3xl font-light tracking-tighter tabular-nums">+10 <span class="text-xs font-medium uppercase tracking-widest text-zen-primary">{UNIT}</span></span>
              <span class="text-xs font-mono text-zen-fg-muted">alice.testnet</span>
            </div>
          {/if}
        </div>
        <div class="flex gap-3">
          <span class="font-mono text-[11px] text-zen-fg-subtle pt-1">0{i + 1}</span>
          <div class="flex flex-col gap-1">
            <h3 class="text-base font-semibold tracking-tight">{s.title}</h3>
            <p class="text-sm text-zen-fg-muted">{s.line}</p>
          </div>
        </div>
      </li>
    {/each}
  </ol>
  <!-- T-001: the unaudited note stays visible on mainnet -->
  {#if !TESTNET}<p class="mt-12 text-xs text-zen-fg-subtle text-center max-w-xl mx-auto">{UNAUDITED_LINE}</p>{/if}
</section>
