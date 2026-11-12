<script lang="ts">
  // Step 3 "Wallet": pay for the send with USDC from Base, Arbitrum or Ethereum (T-019). 1Click turns it into NEAR USDC in
  // the sender's own account; the page then sees the balance and the send goes on as before (ft_transfer_call, unchanged).
  // We only show a deposit address: the sender pays from any wallet. Testnet: live dry mainnet quotes, nothing to pay.
  import { onMount, tick } from 'svelte';
  import { encode } from 'uqr';
  import { ArrowLeftRight, CheckCircle2, Clock, AlertTriangle } from 'lucide-svelte';
  import { evmAddressError, getStatus, QuoteError, type StatusView } from '$lib/intents';
  import {
    describeFunding, followFunding, FUNDING_CHAINS, FUNDING_LIFETIME_MS, getFundingQuote, loadFunding, refundConfirmed, saveFunding,
    TESTNET_PREVIEW_RECIPIENT, type FundingQuote, type SavedFunding,
  } from './fundIn';
  import { formatAmount } from './recipients';
  import CopyButton from '$lib/CopyButton.svelte';
  import Note from '$lib/Note.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenInput from '$lib/zen/components/ZenInput.svelte';

  let { account, contract, need, testnet, onArrived }: {
    account: string; contract: string; need: bigint; testnet: boolean; onArrived: () => void;
  } = $props();

  type Source = 'near' | string; // 'near' or a FUNDING_CHAINS key
  let source = $state<Source>('near');
  let refundTo = $state('');
  let last6 = $state('');
  let busy = $state(false);
  let error = $state('');
  let quote = $state<FundingQuote | null>(null);
  let saved = $state<SavedFunding | null>(null);
  let status = $state<StatusView | null>(null);
  let stopped = false;

  const chain = $derived(FUNDING_CHAINS.find((c) => c.key === (saved?.chainKey ?? source)) ?? null);
  const addrError = $derived(refundTo ? evmAddressError(refundTo.trim()) : null);
  const confirmed = $derived(!addrError && refundConfirmed(refundTo.trim(), last6));
  const line = $derived(saved && status && chain ? describeFunding(status, chain.name, account, saved.refundTo, saved.depositAddress) : null);
  const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(Date.parse(iso));
  const usdc = (v: string) => formatAmount(BigInt(v));
  const feeOf = (i: string, o: string) => (BigInt(i) > BigInt(o) ? BigInt(i) - BigInt(o) : 0n).toString();

  onMount(() => {
    saved = loadFunding(contract, account); // a funding this browser started: keep following it after a reload
    if (saved) follow(saved);
    return () => { stopped = true; };
  });

  function follow(f: SavedFunding) {
    void followFunding(f.depositAddress, (s) => {
      status = s;
      saveFunding(contract, account, { ...f, status: s.status });
      const v = describeFunding(s, chain?.name ?? '', account, f.refundTo, f.depositAddress);
      if (s.status === 'SUCCESS') onArrived(); // the page reads the balance again; the send continues as before
      return v.done;
    }, () => stopped, (a) => getStatus(a));
  }

  async function ask() {
    if (!chain || !confirmed) return;
    error = '';
    busy = true;
    quote = null;
    try {
      const deadline = new Date(Date.now() + FUNDING_LIFETIME_MS).toISOString();
      const q = await getFundingQuote(testnet, { chain, amount: need.toString(), recipient: testnet ? TESTNET_PREVIEW_RECIPIENT : account, refundTo: refundTo.trim(), deadline });
      quote = q;
      if (!testnet && q.depositAddress) {
        saved = { chainKey: chain.key, depositAddress: q.depositAddress, refundTo: refundTo.trim(), amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountOut: q.amountOut, deadline: q.deadline };
        saveFunding(contract, account, saved);
        follow(saved);
      }
    } catch (e) {
      error = e instanceof QuoteError ? e.message : 'Quotes are unavailable right now. Try again, or fund with USDC on NEAR.';
    } finally {
      busy = false;
    }
  }

  function startOver() {
    stopped = true;
    saveFunding(contract, account, null);
    saved = quote = status = null;
    error = last6 = '';
    tick().then(() => (stopped = false));
  }

  const SOURCES = $derived([['near', 'USDC on NEAR'], ...FUNDING_CHAINS.map((c) => [c.key, c.name])] as [Source, string][]);
  function sourceKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = SOURCES.findIndex(([k]) => k === source);
    source = SOURCES[(i + d + SOURCES.length) % SOURCES.length][0];
    quote = null;
    tick().then(() => (document.querySelector(`[data-source="${source}"]`) as HTMLElement | null)?.focus());
  }

  // The QR is drawn from uqr's module matrix as one path: no injected markup.
  const qrPath = (text: string) => {
    const { data } = encode(text, { border: 2 });
    let d = '';
    data.forEach((row, y) => row.forEach((on, x) => { if (on) d += `M${x} ${y}h1v1h-1z`; }));
    return { d, size: data.length };
  };
  const qr = $derived(saved ? qrPath(saved.depositAddress) : null);
</script>

{#snippet row(label: string, value: string, exact = '')}
  <div class="flex items-baseline justify-between gap-4">
    <div class="text-[10px] text-zen-fg-subtle uppercase shrink-0">{label}</div>
    <div class="font-medium text-sm text-right tabular-nums" title={exact || undefined}>{value}</div>
  </div>
{/snippet}

<div class="flex flex-col gap-4" data-fund>
  {#if saved && chain}
    <!-- A deposit address is out: follow it until 1Click reports a final status -->
    <div class="flex flex-col gap-4 py-5 px-5 rounded-2xl bg-zen-fg/5 border border-zen-border-subtle">
      <p class="text-[10px] uppercase tracking-[0.3em] text-zen-fg-subtle font-bold">Funding from {chain.name}</p>
      {@render row('You Send', `${saved.amountInFormatted} USDC on ${chain.name}`)}
      {@render row('You Get', `${usdc(saved.amountOut)} USDC on NEAR`)}
      {@render row('Fee', `${usdc(feeOf(saved.amountIn, saved.amountOut))} USDC`)}
      {@render row('Send Before', when(saved.deadline))}
      {#if !status || status.status === 'PENDING_DEPOSIT'}
        <!-- the address only until a deposit is seen: never invite a second payment -->
        <p class="text-sm text-zen-fg">Send exactly <span class="font-semibold tabular-nums">{saved.amountInFormatted} USDC</span> on {chain.name} to:</p>
        <div class="flex items-start gap-4">
          <svg viewBox="0 0 {qr!.size} {qr!.size}" class="w-28 h-28 shrink-0 rounded-lg bg-white" shape-rendering="crispEdges" role="img" aria-label="QR code of the deposit address">
            <path d={qr!.d} fill="#000" />
          </svg>
          <div class="min-w-0 flex flex-col gap-2">
            <p class="font-mono text-sm break-all text-zen-fg">{saved.depositAddress}</p>
            <CopyButton value={saved.depositAddress} label="Copy Address" />
          </div>
        </div>
        <p class="text-xs text-zen-fg-subtle">Only USDC on {chain.name}, before {when(saved.deadline)}. Any other token or chain is lost.</p>
      {/if}
      {#if line}
        <p class="flex items-start gap-2 text-sm {line.ok ? 'text-zen-fg' : 'text-zen-error'}" role="status">
          {#if status?.status === 'SUCCESS'}<CheckCircle2 class="w-4 h-4 mt-0.5 text-zen-success shrink-0" aria-hidden="true" />
          {:else if line.ok}<Clock class="w-4 h-4 mt-0.5 text-zen-fg-subtle shrink-0" aria-hidden="true" />
          {:else}<AlertTriangle class="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />{/if}
          <span class="min-w-0 break-words">{line.text}</span>
        </p>
      {:else}
        <p class="flex items-center gap-2 text-sm text-zen-fg-muted" role="status"><Clock class="w-4 h-4 shrink-0" aria-hidden="true" />Waiting for your USDC on {chain.name}.</p>
      {/if}
      <div class="flex flex-wrap gap-2">
        <ZenButton variant="ghost" size="sm" onclick={startOver}>{line?.done ? 'Done' : 'Start Over'}</ZenButton>
      </div>
    </div>
  {:else if need > 0n}
    <div class="flex flex-col gap-3">
      <div class="text-[10px] uppercase tracking-[0.3em] text-zen-fg-subtle font-bold" id="pay-with">Pay With</div>
      <div class="flex flex-wrap items-center gap-2" role="radiogroup" aria-labelledby="pay-with" tabindex="-1" onkeydown={sourceKey}>
        {#each SOURCES as [k, label] (k)}
          <ZenButton
            variant={source === k ? 'primary' : 'ghost'}
            size="sm"
            class="px-3 rounded-full text-xs font-medium"
            role="radio"
            aria-checked={source === k}
            tabindex={source === k ? 0 : -1}
            data-source={k}
            onclick={() => ((source = k), (quote = null), (error = ''))}
          >{label}</ZenButton>
        {/each}
      </div>
    </div>
    {#if chain}
      {#if testnet}
        <Note tone="info">Real cross-chain funding runs on mainnet only: 1Click has no testnet. Here you see a live mainnet price, with nothing to pay.</Note>
      {/if}
      <ZenInput label="Your {chain.name} Address" hint="Refunds go here. Your own wallet, not an exchange." placeholder="0x…" bind:value={refundTo} error={addrError} autocomplete="off" spellcheck="false" />
      {#if refundTo && !addrError}
        <ZenInput label="Its Last 6 Characters" hint="Read it again from your wallet." bind:value={last6} maxlength={6} autocomplete="off" spellcheck="false" class="font-mono" />
      {/if}
      <div class="flex flex-wrap items-center gap-3">
        <ZenButton variant="secondary" size="sm" onclick={ask} disabled={!confirmed || busy}>
          {#snippet iconLeft()}<ArrowLeftRight class="w-3.5 h-3.5" />{/snippet}{busy ? 'Getting Quote…' : quote ? 'New Quote' : 'Get Quote'}
        </ZenButton>
        <span class="text-xs text-zen-fg-subtle tabular-nums">For the {formatAmount(need)} USDC still needed</span>
      </div>
      {#if error}<Note tone="error">{error}</Note>{/if}
      {#if quote && testnet}
        <div class="flex flex-col gap-3 py-5 px-5 rounded-2xl bg-zen-fg/5 border border-zen-border-subtle" data-quote>
          {@render row('You Send', `${quote.amountInFormatted} USDC on ${chain.name}`)}
          {@render row('You Get', `${usdc(quote.amountOut)} USDC on NEAR`)}
          {@render row('Fee', `${usdc(quote.fee)} USDC`, `${quote.fee} base units`)}
          {@render row('Arrives In', `About ${Math.max(1, Math.round(quote.timeEstimate / 60))} min after your deposit`)}
          {@render row('Send Before', when(quote.deadline))}
          <p class="text-xs text-zen-fg-subtle">Price checked against 1Click's signature. Quoted to a sample mainnet account, as testnet accounts don't exist there.</p>
        </div>
      {/if}
    {/if}
  {/if}
</div>
