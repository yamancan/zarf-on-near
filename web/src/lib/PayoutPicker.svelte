<script lang="ts">
  // "USDC on another chain": chain + address, then a dry 1Click quote shown before sign-in.
  // The real quote (and its deposit address, which the sign-in binds) is taken on "Sign in".
  import { onMount } from 'svelte';
  import { formatAmount } from '$lib/create/recipients';
  import ZenBadge from '$lib/zen/components/ZenBadge.svelte';
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
        quoteError = e instanceof QuoteError ? `1Click refused this payout: ${e.message}` : 'Cross-chain quotes are unavailable right now. Try again, or claim to a NEAR account.';
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

{#if !mainnet}
  <ul class="flex flex-col" aria-label="Chains">
    {#each PAYOUT_CHAINS as c (c.key)}
      <li class="flex items-center justify-between min-h-11 px-1 text-sm text-zen-fg-muted border-b-[0.5px] border-zen-border-subtle last:border-b-0">
        USDC on {c.name} <ZenBadge size="sm">Mainnet only</ZenBadge>
      </li>
    {/each}
  </ul>
  <p class="text-xs text-zen-fg-subtle pl-1">NEAR Intents runs on mainnet. This testnet demo pays to a NEAR account.</p>
{:else if loadError}
  <p class="text-xs text-zen-error pl-1" role="alert">{loadError}</p>
{:else if !assets}
  <p class="text-xs text-zen-fg-subtle pl-1" role="status">Loading chains…</p>
{:else}
  <label for="chain" class="text-xs font-medium text-zen-fg-muted pl-1 -mb-1">Chain</label>
  <select id="chain" bind:value={key} class="control-border w-full min-h-11 bg-[oklch(from_var(--zen-bg)_l_c_h_/_0.5)] rounded-[var(--zen-radius-input)] px-4 py-3 text-sm text-zen-fg focus:outline-none">
    {#each assets as a (a.chain.key)}<option value={a.chain.key}>USDC on {a.chain.name}</option>{/each}
  </select>
  {#if asset}
    <label for="addr" class="text-xs font-medium text-zen-fg-muted pl-1 -mb-1">Your {asset.chain.name} address</label>
    <input
      id="addr"
      type="text"
      class="control-border w-full min-h-11 bg-[oklch(from_var(--zen-bg)_l_c_h_/_0.5)] rounded-[var(--zen-radius-input)] px-4 py-3 text-sm font-mono text-zen-fg placeholder:text-zen-fg-subtle focus:outline-none"
      bind:value={address}
      placeholder={asset.chain.placeholder}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-invalid={!!addressError}
      aria-describedby="addr-note"
    />
    <div id="addr-note" class="text-xs flex flex-col gap-2">
      {#if addressError}
        <p class="text-zen-error" role="alert">{addressError}</p>
      {:else if quoting}
        <p class="text-zen-fg-subtle" role="status">Getting a quote…</p>
      {:else if quoteError}
        <p class="text-zen-error" role="alert">{quoteError}</p>
      {:else if quote}
        <div class="quote rounded-2xl bg-zen-fg/[0.03] border-[0.5px] border-zen-border-subtle px-4 py-3 flex flex-col gap-1" role="status">
          <p class="text-sm text-zen-fg-muted">
            You receive about <strong class="text-zen-fg font-semibold">{quote.q.amountOutFormatted} USDC on {asset.chain.name}</strong>
            (at least {fmt(quote.q.minAmountOut, asset.decimals)})
          </p>
          <p class="text-zen-fg-subtle">
            Cost {cost(quote.q, asset.decimals)} USDC · about {quote.q.timeEstimate} s · fresh quote at sign-in
          </p>
        </div>
      {/if}
      <p class="text-zen-fg-subtle">
        If it cannot be paid, the USDC returns to <span class="font-mono">{refundTo}</span> on NEAR (the sender), not to this address.
      </p>
      {#if asset.chain.note}<p class="text-zen-fg-subtle">{asset.chain.note}</p>{/if}
    </div>
  {/if}
{/if}
