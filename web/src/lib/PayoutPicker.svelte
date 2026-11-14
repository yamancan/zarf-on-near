<script lang="ts">
  // "USDC on another chain": a chain-logo picker + address, then a dry 1Click quote shown before sign-in.
  // The real quote (and its deposit address, which the sign-in binds) is taken on "Sign in", mainnet only. On testnet
  // the picker explains mainnet availability without asking for an address; `choice` stays null.
  import { onMount } from 'svelte';
  import { formatAmount } from '$lib/create/recipients';
  import { ChevronDown } from 'lucide-svelte';
  import { twoDecimals } from '$lib/claim';
  import { chainLogo } from '$lib/chains';
  import Note from '$lib/Note.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import ZenInput from '$lib/zarf-kit/components/ui/ZenInput.svelte';
  import {
    getQuote, PAYOUT_CHAINS, payoutCapError, withinLossBound, QUOTE_LIFETIME_MS, QuoteError, refusal, resolveAssets, type PayoutAsset, type Quote,
  } from '$lib/intents';

  interface Props {
    network: string; // the contract's get_network()
    amount: string; // leaf amount, NEAR USDC base units
    refundTo: string; // the campaign sender
    choice: { asset: PayoutAsset; recipient: string } | null; // set only when a fair quote exists
    requote?: number; // bumped by "Get a new quote": takes the dry quote again
    onUseNear?: () => void; // the way out when a payout cannot go cross-chain
  }
  let { network, amount, refundTo, requote = 0, onUseNear, choice = $bindable() }: Props = $props();
  const capError = $derived(payoutCapError(amount));
  let tooSmall = $state(false); // the 2% bound refused this payout: say why, offer NEAR

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
    void requote;
    choice = null;
    quote = null;
    quoteError = '';
    tooSmall = false;
    quoting = false;
    if (!mainnet || capError || !a || !recipient || a.chain.addressError(recipient)) return;
    const tag = `${a.assetId}|${recipient}`;
    quoting = true;
    const t = setTimeout(async () => {
      try {
        const pre = a.chain.preflight ? await a.chain.preflight(recipient) : null;
        if (pre) throw new QuoteError(pre);
        const deadline = new Date(Date.now() + QUOTE_LIFETIME_MS).toISOString();
        const q = await getQuote(true, { amount, assetId: a.assetId, recipient, refundTo, deadline });
        if (`${asset?.assetId}|${address.trim()}` !== tag) return; // the field changed meanwhile
        if (!withinLossBound(amount, q.minAmountOut, a.decimals)) {
          quoteError = `The bridge's cost for this payout could be more than 2% of it, our limit. Small payouts often are. Claim it to a NEAR account instead: that has no such limit.`;
          tooSmall = true;
          return;
        }
        quote = { for: tag, q };
        if (mainnet) choice = { asset: a, recipient };
      } catch (e) {
        quoteError = e instanceof QuoteError ? refusal(e.message, a.chain.name) : 'Cross-chain quotes are unavailable right now. Try again, or claim to a NEAR account.';
      } finally {
        quoting = false;
      }
    }, 500);
    return () => clearTimeout(t);
  });

  // Radiogroup keys on the chain logos, as on the Send To pills.
  function chainKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d || !assets?.length) return;
    e.preventDefault();
    const i = assets.findIndex((a) => a.chain.key === key);
    key = assets[(i + d + assets.length) % assets.length].chain.key;
    queueMicrotask(() => (document.querySelector(`[data-chain="${key}"]`) as HTMLElement | null)?.focus());
  }

  // Display only: USDC on every listed chain; amounts in the destination's decimals.
  const fmt = (v: string, decimals: number) => formatAmount(BigInt(v), decimals);
  const cost = (q: Quote, decimals: number) => {
    const out6 = (BigInt(q.amountOut) * 10n ** 6n) / 10n ** BigInt(decimals);
    return formatAmount(BigInt(amount) > out6 ? BigInt(amount) - out6 : 0n);
  };
</script>

{#if !mainnet}
  <p class="text-sm text-zen-fg-muted">Nothing is sent on testnet. Other chains require mainnet; choose a NEAR account to receive these funds.</p>
{/if}
{#if capError}
  <Note tone="error">{capError}</Note>
  {#if onUseNear}<ZenButton variant="secondary" size="sm" class="self-start" onclick={onUseNear}>Use a NEAR Account</ZenButton>{/if}
{:else if loadError}
  <Note tone="error">{loadError}</Note>
{:else if !assets}
  <Note tone="pending">Loading chains…</Note>
{:else}
  {#if mainnet}<p class="text-xs text-zen-fg-muted">Very small payouts may be refused when the bridge's cost is above 2%. Claiming to a NEAR account has no such limit.</p>{/if}
  <!-- One eyebrow per screen ("Send To" above): the chain and address fields carry their names for screen readers -->
  <span id="chain-l" class="sr-only">Chain</span>
  <!-- The chains as their logos (blue-team gap 4): one tap, no menu -->
  <div id="chain" role="radiogroup" aria-labelledby="chain-l" tabindex="-1" class="grid grid-cols-5 gap-1.5" onkeydown={chainKey}>
    {#each assets as a (a.chain.key)}
      <button
        type="button"
        role="radio"
        aria-checked={key === a.chain.key}
        tabindex={key === a.chain.key ? 0 : -1}
        data-chain={a.chain.key}
        class="flex flex-col items-center gap-1 py-2 rounded-xl text-[11px] font-medium transition-colors {key === a.chain.key ? 'bg-zen-fg/10 text-zen-fg' : 'text-zen-fg-muted hover:text-zen-fg'}"
        onclick={() => (key = a.chain.key)}
      ><span class="w-6 h-6" aria-hidden="true">{@html chainLogo(a.chain)}</span><span class="w-full truncate text-center">{a.chain.name}</span></button>
    {/each}
  </div>
  {#if asset && mainnet}
    <ZenInput
      id="addr"
      aria-label="{asset.chain.name} address"
      class="font-mono"
      bind:value={address}
      placeholder={asset.chain.placeholder}
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      error={addressError}
      hint="Your own wallet, not an exchange."
    />
    <div id="addr-note" class="flex flex-col gap-2 pl-1" aria-live="polite">
      {#if addressError}
        <!-- shown under the field -->
      {:else if quoting}
        <Note tone="pending">Getting a quote…</Note>
      {:else if quoteError}
        <Note tone="error">{quoteError}</Note>
        {#if tooSmall && onUseNear}<ZenButton variant="secondary" size="sm" class="self-start" onclick={onUseNear}>Use a NEAR Account</ZenButton>{/if}
      {:else if quote}
        <p class="quote text-sm text-zen-fg tabular-nums" role="status">
          <span class="font-semibold">≈ {twoDecimals(quote.q.amountOutFormatted)} USDC</span>
          <span class="text-zen-fg-muted">· about {quote.q.timeEstimate} s</span>
        </p>
      {/if}
      <details class="group text-xs text-zen-fg-subtle">
        <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none hover:text-zen-fg">
          Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" />
        </summary>
        <div class="flex flex-col gap-2 leading-relaxed">
          {#if quote}
            <p class="text-xs text-zen-fg-subtle">
              About {quote.q.amountOutFormatted} USDC, at least {fmt(quote.q.minAmountOut, asset.decimals)}. Cost
              {cost(quote.q, asset.decimals)} USDC. A fresh quote is taken when you sign in.
            </p>
          {/if}
          <p class="text-xs text-zen-fg-muted">If the bridge does not complete the payout by its deadline, it refunds <span class="font-mono">{refundTo}</span> on NEAR (the sender), not this address.</p>
        </div>
      </details>
    </div>
  {/if}
{/if}
