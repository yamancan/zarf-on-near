<script lang="ts">
  // How It Works (T-033 Part A, owner: the T-032 pictures "look made-up"). Each step is a slice of the real screen it
  // describes, drawn with that screen's own parts and type, at real size, in the same card, cropped at the same height
  // and faded out at the bottom: the send grid (RecipientAllocationGrid's rows), the claim card the recipient opens
  // (ClaimCard itself, inert), and the receipt (its own header and AmountPanel). One story runs through all three:
  // ana@gmail.com is sent 25 USDC, opens it, and it arrives in ana.testnet. Pictures only: inert, hidden from
  // assistive tech; the heading and line under each say what it shows.
  import AmountPanel from '$lib/AmountPanel.svelte';
  import Avatar from '$lib/Avatar.svelte';
  import ClaimCard from '$lib/ClaimCard.svelte';
  import { TESTNET, UNIT } from '$lib/network';
  import ZenCard from '$lib/zarf-kit/components/ui/ZenCard.svelte';

  const SENDER = TESTNET ? 'maya.testnet' : 'maya.near';
  const ACCOUNT = TESTNET ? 'ana.testnet' : 'ana.near';
  const ROWS = [
    { email: 'ana@gmail.com', amount: '25' },
    { email: 'kerem@gmail.com', amount: '40' },
    { email: 'li.wei@gmail.com', amount: '12.5' },
    { email: 'sofia@gmail.com', amount: '30' },
  ];
  // RecipientAllocationGrid's own columns, without the delete column (no control in a picture)
  const COLUMNS = 'grid-cols-[2rem_minmax(0,1fr)_5rem] sm:grid-cols-[2.5rem_minmax(0,1fr)_7rem]';
</script>

{#snippet slice(content: import('svelte').Snippet)}
  <div class="h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_72%,transparent)] select-none" inert aria-hidden="true">
    <ZenCard variant="elevated" class="overflow-hidden min-h-80">
      <div class="p-6">{@render content()}</div>
    </ZenCard>
  </div>
{/snippet}

{#snippet grid()}
  <!-- RecipientAllocationGrid's header and rows (zarf-kit/create/RecipientAllocationGrid.svelte:130-200), values in place -->
  <div class="-mx-6 -mt-6">
    <div class="grid {COLUMNS} items-center gap-2 border-b border-zen-border-subtle bg-zen-fg/[0.02] px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-zen-fg-subtle">
      <span>#</span><span>Email</span><span class="text-right">Amount</span>
    </div>
    <div class="divide-y divide-zen-border-subtle">
      {#each ROWS as r, i (r.email)}
        <div class="grid {COLUMNS} items-center gap-2 px-3 py-2">
          <span class="text-xs tabular-nums text-zen-fg-faint">{i + 1}</span>
          <span class="truncate px-1.5 py-1 font-mono text-xs text-zen-fg">{r.email}</span>
          <span class="flex h-8 items-center justify-end rounded-lg border border-zen-border bg-zen-fg/[0.03] px-2.5 font-mono text-xs tabular-nums text-zen-fg">{r.amount}</span>
        </div>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet claim()}
  <ClaimCard
    preview
    title={TESTNET ? 'Claim Your Test USDC' : 'Claim Your USDC'}
    sender={SENDER}
    left="6 days left"
    amount="25"
    unit={UNIT}
    modes={TESTNET ? [['existing', 'NEAR Account'], ['new', 'Face ID'], ['chain', 'Other Chain']] : [['existing', 'NEAR Account'], ['chain', 'Other Chain']]}
    mode="existing"
  />
{/snippet}

{#snippet arrived()}
  <!-- The receipt's own header and amount (claim/[campaign]/[commitment]/receipt/+page.svelte nearDone) -->
  <div class="space-y-8">
    <div class="min-w-0">
      <div class="text-xl font-semibold">Arrived</div>
      <p class="text-sm text-zen-fg-muted font-light mt-1 flex items-center gap-1.5">
        <span class="text-zen-fg-subtle">To</span><Avatar name={ACCOUNT} /><span class="font-mono truncate">{ACCOUNT}</span>
      </p>
    </div>
    <AmountPanel label="You Received" value="25" unit={UNIT} />
  </div>
{/snippet}

<section class="pt-4 md:pt-8 pb-24" aria-label="How it works">
  <ol class="container mx-auto px-6 max-w-6xl grid md:grid-cols-3 gap-12 md:gap-8">
    <li>
      {@render slice(grid)}
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">Add Emails and Amounts</h2>
      <p class="text-sm text-zen-fg-muted">Pay once, in USDC.</p>
    </li>
    <li>
      {@render slice(claim)}
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">They Claim with Google</h2>
      <p class="text-sm text-zen-fg-muted">No gas and no seed phrase.</p>
    </li>
    <li>
      {@render slice(arrived)}
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">USDC Arrives</h2>
      <p class="text-sm text-zen-fg-muted">In their NEAR account, or on the chain they pick.</p>
    </li>
  </ol>
</section>
