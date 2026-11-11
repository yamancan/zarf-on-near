<script lang="ts">
  // A claim the chain says is claimed, with what this browser remembers of it. It never says more than was
  // confirmed: a cross-chain payout the bridge has not settled reads "Claimed on NEAR", not "Paid out".
  import { env } from '$env/dynamic/public';
  import { AlertTriangle, ArrowUpRight, Check, Clock, Undo2 } from 'lucide-svelte';
  import { claimedAt, middle, twoDecimals, type Receipt } from '$lib/claim';
  import { formatAmount } from '$lib/create/recipients';
  import { UNIT } from '$lib/network';
  import Amount from '$lib/Amount.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';

  let { r, amount, title }: { r: Receipt | null; amount: string; title: string } = $props();
  const state = $derived(!r ? 'unknown' : r.chainName ? (r.bridge ?? 'in-transit') : 'paid');
</script>

{#if state === 'paid'}<Medallion icon={Check} tone="success" />
{:else if state === 'in-transit'}<Medallion icon={Clock} tone="muted" />
{:else if state === 'refunded'}<Medallion icon={Undo2} tone="error" />
{:else if state === 'failed'}<Medallion icon={AlertTriangle} tone="error" />
{:else}<Medallion icon={Check} tone="muted" />{/if}
<h1 class="text-xl font-semibold tracking-tight">{title}</h1>
<Amount
  label={state === 'unknown' ? 'This link held' : state === 'paid' ? 'Paid out' : state === 'in-transit' ? 'Claimed on NEAR' : state === 'refunded' ? 'Returned to the sender' : 'Not delivered'}
  value={formatAmount(BigInt(amount))}
  unit={UNIT}
  struck={state === 'refunded'}
/>
{#if !r}
  <p class="text-sm text-zen-fg-muted max-w-xs">This link has already been claimed. If that was not you, contact the sender.</p>
{:else}
  <p class="text-sm text-zen-fg-muted max-w-xs">
    {#if state === 'paid'}
      to <span class="font-mono text-zen-fg" title={r.destination}>{middle(r.destination, 8)}</span>{#if r.chainName}{' '}on {r.chainName}{#if r.amountOut}{' · '}≈ {twoDecimals(r.amountOut)} USDC{/if}{/if}
    {:else if state === 'in-transit'}
      On its way to <span class="font-mono text-zen-fg" title={r.destination}>{middle(r.destination)}</span> on {r.chainName}. The bridge had not confirmed it when this browser last checked.
    {:else if state === 'refunded'}
      The bridge could not pay it out on {r.chainName} and returned it to the sender on NEAR.
    {:else}
      The bridge could not pay it out on {r.chainName}. Contact the sender.
    {/if}
  </p>
  {#if r.at}<p class="text-xs text-zen-fg-muted">Claimed {claimedAt(r.at)}</p>{/if}
  {#if env.PUBLIC_EXPLORER_TX_URL}
    <ZenButton href="{env.PUBLIC_EXPLORER_TX_URL}{r.txHash}" target="_blank" rel="noopener noreferrer" variant="secondary" class="rounded-full min-h-11">
      View the transaction
      {#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}
    </ZenButton>
  {:else}
    <p class="text-xs text-zen-fg-muted">Transaction <span class="font-mono">{middle(r.txHash, 8)}</span></p>
  {/if}
{/if}
