<script lang="ts">
  // How It Works (T-032, owner point 7): three steps, one short line each, and a picture of what the step looks like.
  import GoogleG from '$lib/GoogleG.svelte';
  import Mark from '$lib/Mark.svelte';
  import { MARKS, PAYOUT_CHAINS } from '$lib/chains';

  const ROWS = [
    { email: 'ana@gmail.com', amount: '25' },
    { email: 'kerem@acme.com', amount: '40' },
  ];
  const CHAINS = PAYOUT_CHAINS.filter((c) => ['base', 'sol', 'arb'].includes(c.key));
</script>

<section class="py-24" aria-label="How it works">
  <ol class="container mx-auto px-6 max-w-6xl grid md:grid-cols-3 gap-12 md:gap-10">
    <li>
      <div class="h-36 rounded-2xl border border-zen-border-subtle bg-zen-bg flex flex-col justify-center px-5" aria-hidden="true">
        {#each ROWS as r, i (r.email)}
          <div class="flex items-center justify-between gap-3 py-2.5 text-sm {i ? 'border-t border-zen-border-subtle' : ''}">
            <span class="text-zen-fg truncate">{r.email}</span>
            <span class="inline-flex items-center gap-1.5 font-medium tabular-nums text-zen-fg">{r.amount}<Mark svg={MARKS.usdc} class="w-4 h-4" /></span>
          </div>
        {/each}
      </div>
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">Add Emails and Amounts</h2>
      <p class="text-sm text-zen-fg-muted">Pay once, in USDC.</p>
    </li>
    <li>
      <div class="h-36 rounded-2xl border border-zen-border-subtle bg-zen-bg flex items-center justify-center" aria-hidden="true">
        <span class="inline-flex items-center rounded-full bg-zen-fg text-zen-bg text-sm font-medium h-11 px-5"><GoogleG />Sign in with Google</span>
      </div>
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">They Sign in with Google</h2>
      <p class="text-sm text-zen-fg-muted">No wallet, no gas. The email stays off chain.</p>
    </li>
    <li>
      <div class="h-36 rounded-2xl border border-zen-border-subtle bg-zen-bg flex flex-col items-center justify-center gap-3" aria-hidden="true">
        <span class="inline-flex items-center gap-2 text-3xl font-semibold tabular-nums text-zen-fg">+25<Mark svg={MARKS.usdc} class="w-7 h-7" /></span>
        <span class="inline-flex items-center gap-1.5">
          <Mark svg={MARKS.near} class="w-5 h-5" />
          {#each CHAINS as c (c.key)}<Mark svg={c.logo} class="w-5 h-5" />{/each}
        </span>
      </div>
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">USDC Arrives</h2>
      <p class="text-sm text-zen-fg-muted">On NEAR, or on the chain they pick.</p>
    </li>
  </ol>
</section>
