<script lang="ts">
  // A claim the chain says is claimed, with what this browser remembers of it. It never says more than was
  // confirmed: a cross-chain payout the bridge has not settled reads "On its way", not "Paid out". A record
  // that is not settled asks the bridge again while it is shown (the tab that followed the payout may be gone).
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { AlertTriangle, ArrowUpRight, Check, Clock, Undo2 } from 'lucide-svelte';
  import { claimedAt, middle, shownAmount, type Receipt } from '$lib/claim';
  import { needsRecheck, nextStep, recheckReceipt } from '$lib/intents';
  import { formatAmount } from '$lib/create/recipients';
  import { UNIT } from '$lib/network';
  import Amount from '$lib/Amount.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';

  let { r, amount, title, contract, campaign, commitment }: {
    r: Receipt | null; amount: string; title?: string; contract: string; campaign: string; commitment: string;
  } = $props();
  // svelte-ignore state_referenced_locally
  let rec = $state(r); // updated from the bridge's answers
  const kind = $derived(!rec ? 'unknown' : rec.chainName ? (rec.bridge ?? 'in-transit') : 'paid');
  const shown = $derived(shownAmount(rec ?? {}, formatAmount(BigInt(amount)), UNIT));
  const heading = $derived(
    title ?? (kind === 'paid' ? (rec?.chainName ? `Arrived on ${rec.chainName}` : 'Arrived') : kind === 'in-transit' ? `On its way to ${rec?.chainName}` : kind === 'failed' ? 'Payout failed' : 'Not delivered'),
  );

  onMount(() => {
    let stop = false;
    (async () => {
      // Same cap as the receipt's live watch: 30 minutes, every 10 s; then the "last checked" line stays.
      for (let i = 0; i < 180 && !stop && needsRecheck(rec); i++) {
        try {
          const a = await recheckReceipt(contract, campaign, commitment, rec!);
          if (stop) return;
          rec = a.r;
          if (a.done) return;
        } catch {
          // a failed read says nothing about the payout; the "last checked" line keeps the older time
        }
        await new Promise((ok) => setTimeout(ok, 10_000));
      }
    })();
    return () => { stop = true; };
  });
</script>

{#if kind === 'paid'}<Medallion icon={Check} tone="success" />
{:else if kind === 'in-transit'}<Medallion icon={Clock} tone="muted" />
{:else if kind === 'refunded'}<Medallion icon={Undo2} tone="error" />
{:else if kind === 'failed'}<Medallion icon={AlertTriangle} tone="error" />
{:else}<Medallion icon={Check} tone="muted" />{/if}
<h1 class="text-xl font-semibold tracking-tight">{heading}</h1>
<Amount
  label={kind === 'unknown' ? 'This link held' : kind === 'paid' ? 'Paid out' : kind === 'in-transit' ? 'On its way' : kind === 'refunded' ? 'Returned to the sender' : 'Not delivered'}
  value={shown.value}
  unit={shown.unit}
  struck={kind === 'refunded'}
/>
{#if !rec}
  <p class="text-sm text-zen-fg-muted max-w-xs">If that was not you, contact the sender.</p>
{:else}
  <p class="text-sm text-zen-fg-muted max-w-xs" role="status">
    {#if kind === 'paid'}
      to <span class="font-mono text-zen-fg" title={rec.destination}>{middle(rec.destination, rec.chainName ? 6 : 8)}</span>{#if rec.chainName}{' '}on {rec.chainName}{/if}
    {:else if kind === 'in-transit'}
      to <span class="font-mono text-zen-fg" title={rec.destination}>{middle(rec.destination)}</span> on {rec.chainName}. Claimed on NEAR; the bridge has not confirmed the payout yet.
    {:else if kind === 'refunded'}
      The bridge could not pay it out on {rec.chainName} and returned it to {rec.refundTo ?? 'the sender'} on NEAR. {nextStep('refunded', '')}
    {:else}
      The bridge could not pay it out on {rec.chainName}. {nextStep('failed', rec.refundTo ?? 'the sender')}
    {/if}
  </p>
  {#if rec.chainName && kind !== 'paid' && rec.checkedAt}
    <p class="text-xs text-zen-fg-muted">Bridge last checked {claimedAt(rec.checkedAt)}</p>
  {:else if rec.at}
    <p class="text-xs text-zen-fg-muted">Claimed {claimedAt(rec.at)}</p>
  {/if}
  {#if env.PUBLIC_EXPLORER_TX_URL}
    <ZenButton href="{env.PUBLIC_EXPLORER_TX_URL}{rec.txHash}" target="_blank" rel="noopener noreferrer" variant="secondary" class="rounded-full min-h-11">
      View the transaction
      {#snippet iconRight()}<ArrowUpRight class="w-3.5 h-3.5" />{/snippet}
    </ZenButton>
  {:else}
    <p class="text-xs text-zen-fg-muted">Transaction <span class="font-mono">{middle(rec.txHash, 8)}</span></p>
  {/if}
{/if}
