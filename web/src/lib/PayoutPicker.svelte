<script lang="ts">
  // "USDC on another chain" (mainnet only): chain + address, then a dry 1Click quote shown before sign-in.
  // The real quote (and its deposit address, which the sign-in binds) is taken on "Sign in".
  import { onMount } from 'svelte';
  import { formatAmount } from '$lib/create/recipients';
  import { ChevronDown } from 'lucide-svelte';
  import { twoDecimals } from '$lib/claim';
  import Note from '$lib/Note.svelte';
  import ZenInput from '$lib/zen/components/ZenInput.svelte';
  import ZenSelect from '$lib/zen/components/ZenSelect.svelte';
  import {
    getQuote, lossBps, MAX_LOSS_BPS, PAYOUT_CHAINS, QUOTE_LIFETIME_MS, QuoteError, resolveAssets, type PayoutAsset, type Quote,
  } from '$lib/intents';

  interface Props {
    network: string; // the contract's get_network()
    amount: string; // leaf amount, NEAR USDC base units
    refundTo: string; // the campaign sender
    choice: { asset: PayoutAsset; recipient: string } | null; // set only when a fair quote exists
  }
  let { network, amount, refundTo, choice = $bindable() }: Props = $props();

  const mainnet = $derived(network === 'mainnet');
  let assets = $state<PayoutAsset[] | null>(null);
  let loadError = $state('');
  let key = $state(PAYOUT_CHAINS[0].key);
  let address = $state('');
  let quote = $state<{ for: string; q: Quote } | null>(null);
  let quoteError = $state('');
  let quoting = $state(false);

  const asset = $derived(assets?.find((a) => a.chain.key === key) ?? assets?.[0] ?? null);
  const addressError = $derived(asset && address.trim() ? asset.chain.addressError(address.trim()) : null);

  onMount(async () => {
    if (!mainnet) return;
    try {
      assets = await resolveAssets();
      if (!assets.length) loadError = 'Cross-chain payouts are unavailable right now. Claim to a NEAR account instead.';
    } catch {
      loadError = 'Cross-chain payouts are unavailable right now. Claim to a NEAR account, or try again later.';
    }
  });

  $effect(() => {
    const a = asset;
    const recipient = address.trim();
    choice = null;
    quote = null;
    quoteError = '';
    if (!a || !recipient || a.chain.addressError(recipient)) return;
    const tag = `${a.assetId}|${recipient}`;
    quoting = true;
    const t = setTimeout(async () => {
      try {
        const pre = a.chain.preflight ? await a.chain.preflight(recipient) : null;
        if (pre) throw new QuoteError(pre);
        const deadline = new Date(Date.now() + QUOTE_LIFETIME_MS).toISOString();
        const q = await getQuote(true, { amount, assetId: a.assetId, recipient, refundTo, deadline });
        if (`${asset?.assetId}|${address.trim()}` !== tag) return; // the field changed meanwhile
        const loss = lossBps(amount, q.minAmountOut, a.decimals);
        if (loss > MAX_LOSS_BPS) {
          quoteError = `Sending this amount to ${a.chain.name} could cost up to ${(loss / 100).toFixed(1)}% of it. Claim it to a NEAR account instead.`;
          return;
        }
        quote = { for: tag, q };
        choice = { asset: a, recipient };
      } catch (e) {
        quoteError = e instanceof QuoteError ? `The bridge refused this payout: ${e.message}` : 'Cross-chain quotes are unavailable right now. Try again, or claim to a NEAR account.';
      } finally {
        quoting = false;
      }
    }, 500);
    return () => clearTimeout(t);
  });

  // Display only: USDC on every listed chain; amounts in the destination's decimals.
  const fmt = (v: string, decimals: number) => formatAmount(BigInt(v), decimals);
  const cost = (q: Quote, decimals: number) => {
    const out6 = (BigInt(q.amountOut) * 10n ** 6n) / 10n ** BigInt(decimals);
    return formatAmount(BigInt(amount) > out6 ? BigInt(amount) - out6 : 0n);
  };
</script>

{#if loadError}
  <Note tone="error">{loadError}</Note>
{:else if !assets}
  <Note tone="pending">Loading chains…</Note>
{:else}
  <span id="chain-l" class="text-sm font-medium text-zen-fg">Chain</span>
  <div id="chain" role="group" aria-labelledby="chain-l">
    <ZenSelect bind:value={key} options={assets.map((a) => ({ value: a.chain.key, label: `USDC on ${a.chain.name}` }))} aria-label="Chain" class="w-full [&>button]:w-full [&>button]:min-h-11 [&>button]:!border [&>button]:!border-[var(--zarf-control-border)]" />
  </div>
  {#if asset}
    <label for="addr" class="text-sm font-medium text-zen-fg">Your {asset.chain.name} address</label>
    <ZenInput
      id="addr"
      class="control-border font-mono"
      bind:value={address}
      placeholder={asset.chain.placeholder}
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      aria-invalid={!!addressError}
      aria-describedby="addr-note"
    />
    <div id="addr-note" class="flex flex-col gap-2 pl-1">
      {#if addressError}
        <Note tone="error">{addressError}</Note>
      {:else if quoting}
        <Note tone="pending">Getting a quote…</Note>
      {:else if quoteError}
        <Note tone="error">{quoteError}</Note>
      {:else if quote}
        <p class="quote text-sm text-zen-fg" role="status">
          <span class="font-semibold tabular-nums">≈ {twoDecimals(quote.q.amountOutFormatted)} USDC</span> on {asset.chain.name}
          <span class="text-zen-fg-muted">· about {quote.q.timeEstimate} s</span>
        </p>
      {/if}
      <details class="group text-xs text-zen-fg-muted">
        <summary class="inline-flex items-center gap-1.5 min-h-11 cursor-pointer list-none hover:text-zen-fg">
          Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div class="flex flex-col gap-2 leading-relaxed">
          {#if quote}
            <p>
              About {quote.q.amountOutFormatted} USDC, at least {fmt(quote.q.minAmountOut, asset.decimals)}. Cost
              {cost(quote.q, asset.decimals)} USDC. A fresh quote is taken when you sign in.
            </p>
          {/if}
          <p>If it cannot be paid, the USDC returns to <span class="font-mono">{refundTo}</span> on NEAR (the sender), not to this address.</p>
          {#if asset.chain.note}<p>{asset.chain.note}</p>{/if}
        </div>
      </details>
    </div>
  {/if}
{/if}
