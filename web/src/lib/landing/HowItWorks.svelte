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
  import { TESTNET } from '$lib/network';
  import ZenCard from '$lib/zarf-kit/components/ui/ZenCard.svelte';

  // The landing names no testnet (owner, T-040): the pictures show the product as it reads on mainnet.
  const SENDER = 'maya.near';
  const ACCOUNT = 'ana.near';
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
  <!-- The send screen's own title and RecipientAllocationGrid's rows (zarf-kit/create/RecipientAllocationGrid.svelte:130-200):
       values as plain text (a picture, not inputs), the grid's own hairlines, numbers and columns -->
  <div class="space-y-6">
    <div class="text-xl font-semibold">Recipients</div>
    <div class="-mx-6 divide-y divide-zen-border-subtle border-y border-zen-border-subtle">
      {#each ROWS as r, i (r.email)}
        <div class="grid {COLUMNS} items-center gap-2 px-3 py-2.5">
          <span class="text-xs tabular-nums text-zen-fg-faint">{i + 1}</span>
          <span class="truncate px-1.5 text-sm text-zen-fg">{r.email}</span>
          <span class="px-2.5 text-right text-sm tabular-nums text-zen-fg">{r.amount}</span>
        </div>
      {/each}
    </div>
  </div>
{/snippet}

{#snippet claim()}
  <ClaimCard
    preview
    title="Claim Your USDC"
    sender={SENDER}
    left="6 days left"
    amount="25"
    unit="USDC"
    modes={[['existing', 'NEAR Account']]}
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
    <AmountPanel label="You Received" value="25" unit="USDC" />
    <p class="text-xs text-zen-fg-subtle">Zarf paid the network fee; the Zarf contract sent the USDC.</p>
  </div>
{/snippet}

<section class="pt-4 md:pt-8 pb-24" aria-label="How it works">
  <!-- Three columns from lg: at 768 px three slices were too narrow and collapsed (T-041); below lg one column, phone width -->
  <ol class="container mx-auto px-6 max-w-6xl grid lg:grid-cols-3 gap-12 lg:gap-8">
    <li class="w-full max-w-md mx-auto lg:max-w-none">
      {@render slice(grid)}
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">Add Emails and Amounts</h2>
      <p class="text-sm text-zen-fg-muted">Pay once, in USDC.</p>
    </li>
    <li class="w-full max-w-md mx-auto lg:max-w-none">
      {@render slice(claim)}
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">They Claim with Google</h2>
      <p class="text-sm text-zen-fg-muted">No gas and no seed phrase.</p>
    </li>
    <li class="w-full max-w-md mx-auto lg:max-w-none">
      {@render slice(arrived)}
      <h2 class="text-xl font-semibold mt-6 mb-1.5 tracking-tight text-base-content">USDC Arrives</h2>
      <!-- Payouts to other chains are mainnet only and not yet run with real money: testnet promises the NEAR account only -->
      <p class="text-sm text-zen-fg-muted">{TESTNET ? 'In their NEAR account.' : 'In their NEAR account, or on the chain they pick.'}</p>
    </li>
  </ol>
</section>
