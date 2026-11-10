<script lang="ts">
  // "USDC on another chain": chain + address, then a dry 1Click quote shown before sign-in.
  // The real quote (and its deposit address, which the sign-in binds) is taken on "Sign in".
  import { onMount } from 'svelte';
  import { formatAmount } from '$lib/create/recipients';
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
  <ul class="chains">
    {#each PAYOUT_CHAINS as c (c.key)}<li>USDC on {c.name} <span class="muted">· mainnet only</span></li>{/each}
  </ul>
  <p class="muted">Cross-chain payouts use NEAR Intents, which runs on mainnet only. This testnet demo pays to a NEAR account.</p>
{:else if loadError}
  <p class="error" role="alert">{loadError}</p>
{:else if !assets}
  <p class="muted" role="status">Loading chains…</p>
{:else}
  <label for="chain">Chain</label>
  <select id="chain" bind:value={key}>
    {#each assets as a (a.chain.key)}<option value={a.chain.key}>USDC on {a.chain.name}</option>{/each}
  </select>
  {#if asset}
    <p>
      If the payout cannot be completed, the USDC returns to <code>{refundTo}</code> on NEAR (the sender), not to this
      address.
    </p>
    <label for="addr">Your {asset.chain.name} address</label>
    <input
      id="addr"
      type="text"
      bind:value={address}
      placeholder={asset.chain.placeholder}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      aria-invalid={!!addressError}
      aria-describedby="addr-note"
    />
    <div id="addr-note">
      {#if addressError}
        <p class="error" role="alert">{addressError}</p>
      {:else if quoting}
        <p class="muted" role="status">Getting a quote…</p>
      {:else if quoteError}
        <p class="error" role="alert">{quoteError}</p>
      {:else if quote}
        <p class="quote" role="status">
          You receive about <strong>{quote.q.amountOutFormatted} USDC on {asset.chain.name}</strong> (at least
          {fmt(quote.q.minAmountOut, asset.decimals)}). Network and swap cost: {cost(quote.q, asset.decimals)} USDC. Usually
          arrives about {quote.q.timeEstimate} s after the claim. A fresh quote is taken when you sign in.
        </p>
      {/if}
      <p class="muted">{asset.chain.note}</p>
    </div>
  {/if}
{/if}

<style>
  .chains {
    padding-left: 1.25rem;
    margin: 0.25rem 0;
  }
  select {
    width: 100%;
    padding: 0.75rem;
    font: inherit;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: inherit;
  }
  .quote {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 0.75rem;
  }
</style>
