<script lang="ts">
  // Step 2 "Pay": Pay With, a row of chain logos with USDC on NEAR first (T-019, T-025, T-024 restyle). Another chain:
  // 1Click turns its USDC into NEAR USDC in the sender's own account; the page then sees the balance and the send goes
  // on as before (ft_transfer_call, unchanged). We only show a deposit address: the sender pays from any wallet.
  // Testnet: live dry mainnet quotes, nothing to pay. A MetaMask (0x) sender's refund address is their own account.
  import { onMount, tick } from 'svelte';
  import { encode } from 'uqr';
  import { ArrowLeftRight, CheckCircle2, Clock, AlertTriangle } from 'lucide-svelte';
  import { chainLogo, evmAddressError, markLogo, MARKS } from '$lib/chains';
  import { middle } from '$lib/claim';
  import { getStatus, QuoteError, type StatusView } from '$lib/intents';
  import {
    archiveFunding, describeFunding, earlierFundings, followFunding, FUNDING_CHAINS, FUNDING_LIFETIME_MS, getFundingQuote, loadFunding, mayPay, mayStartOver, refundConfirmed, saveFunding, unresolved,
    TESTNET_PREVIEW_RECIPIENT, type FundingQuote, type SavedFunding,
  } from './fundIn';
  import { formatAmount } from './recipients';
  import CopyButton from '$lib/CopyButton.svelte';
  import Note from '$lib/Note.svelte';
  import ZenBadge from '$lib/zarf-kit/components/ui/ZenBadge.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import ZenInput from '$lib/zarf-kit/components/ui/ZenInput.svelte';

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
  let fresh = $state(false); // 1Click answered for this address since it was shown (a just-made quote counts)
  let stalled = $state(false); // the poller gave up after an hour: "Check Again" follows the same address
  let now = $state(Date.now()); // the deadline check needs a clock that moves
  let unmounted = false;
  let poller = 0; // each follow() gets its own number; an older poller never writes again
  let request = 0; // the same for quote requests: a reply to an older request is dropped

  const chain = $derived(FUNDING_CHAINS.find((c) => c.key === (saved?.chainKey ?? source)) ?? null);
  // A MetaMask sender's NEAR account is its Ethereum address (NEP-518): on an EVM chain that address is theirs, so it is
  // the refund address, with nothing to type or read back.
  const ownRefund = $derived(!saved && chain && chain.addressError === evmAddressError && /^0x[0-9a-f]{40}$/.test(account) ? account : '');
  // Derived, never copied into refundTo: switching between EVM chains keeps it (T-024 review finding 3).
  const refund = $derived(ownRefund || refundTo.trim());
  const addrError = $derived(!ownRefund && refundTo && chain ? chain.addressError(refundTo.trim()) : null);
  const confirmed = $derived(!!ownRefund || (!addrError && refundConfirmed(refundTo.trim(), last6)));
  const line = $derived(saved && status && chain ? describeFunding(status, chain.name, account, saved.refundTo, saved.depositAddress) : null);
  const canPay = $derived(!!saved && mayPay(status?.status, fresh, saved.deadline, now));
  const expired = $derived(!!saved && Date.parse(saved.deadline) <= now && (!status || status.status === 'PENDING_DEPOSIT'));
  const canStartOver = $derived(!!saved && mayStartOver(status?.status, fresh, saved.deadline, now));
  let earlier = $state<SavedFunding[]>([]);
  const when = (iso: string) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(Date.parse(iso));
  const usdc = (v: string) => formatAmount(BigInt(v));
  const feeOf = (i: string, o: string) => (BigInt(i) > BigInt(o) ? BigInt(i) - BigInt(o) : 0n).toString();

  onMount(() => {
    // A funding this browser started: its last known status at once, the address only after 1Click answers again.
    saved = loadFunding(contract, account);
    earlier = earlierFundings(contract, account);
    if (saved) {
      status = saved.status ? { status: saved.status } : null;
      if (!saved.status || !describeFunding({ status: saved.status }, '', '', '', '').done) follow(saved);
    }
    const t = setInterval(() => (now = Date.now()), 15_000);
    return () => ((unmounted = true), poller++, clearInterval(t));
  });

  function follow(f: SavedFunding) {
    const mine = ++poller;
    stalled = false;
    const chainName = FUNDING_CHAINS.find((c) => c.key === f.chainKey)?.name ?? '';
    void followFunding(f.depositAddress, (s) => {
      status = s;
      fresh = true;
      saved = { ...f, status: s.status };
      saveFunding(contract, account, saved);
      if (s.status === 'SUCCESS') onArrived(); // the page reads the balance again; the send continues as before
      return describeFunding(s, chainName, account, f.refundTo, f.depositAddress).done;
    }, () => unmounted || mine !== poller, (a) => getStatus(a)).then((end) => {
      if (end === 'timeout' && mine === poller) stalled = true;
    });
  }

  async function ask() {
    if (!chain || !confirmed || busy) return;
    // Everything the quote is for, fixed now: the controls are disabled until it returns, and a reply to an
    // older request (or after unmount) is dropped, so a quote is never shown or saved under another chain or address.
    const ctx = { chain, refundTo: refund, account, need, mine: ++request };
    error = '';
    busy = true;
    quote = null;
    try {
      const deadline = new Date(Date.now() + FUNDING_LIFETIME_MS).toISOString();
      const q = await getFundingQuote(testnet, { chain: ctx.chain, amount: ctx.need.toString(), recipient: testnet ? TESTNET_PREVIEW_RECIPIENT : ctx.account, refundTo: ctx.refundTo, deadline });
      if (unmounted || ctx.mine !== request) return;
      quote = q;
      if (!testnet && q.depositAddress) {
        saved = { chainKey: ctx.chain.key, depositAddress: q.depositAddress, refundTo: ctx.refundTo, amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, amountOut: q.amountOut, deadline: q.deadline };
        saveFunding(contract, ctx.account, saved);
        status = null;
        fresh = true; // just quoted: the address may be shown at once
        follow(saved);
      }
    } catch (e) {
      if (unmounted || ctx.mine !== request) return;
      error = e instanceof QuoteError ? e.message : 'Quotes are unavailable right now. Try again, or fund with USDC on NEAR.';
    } finally {
      if (ctx.mine === request) busy = false;
    }
  }

  // A shown quote belongs to the address it was asked for: editing the address drops it (and any reply still out).
  $effect(() => {
    void refund;
    quote = null;
    request++;
  });

  /** Only offered when nothing more can arrive at the address (mayStartOver): the record is then dropped. */
  function startOver() {
    if (!canStartOver) return;
    if (saved && unresolved(status?.status)) {
      // expired and unpaid as far as 1Click knows: kept as a reference, or the active record stays
      if (!archiveFunding(contract, account, saved)) {
        error = "Couldn't keep this address for later in this browser, so it stays here. Note it down, then try again.";
        return;
      }
      earlier = earlierFundings(contract, account);
    }
    poller++; // only now: a record kept after a failed archive keeps being followed
    saveFunding(contract, account, null);
    saved = quote = status = null;
    fresh = stalled = false;
    error = last6 = '';
  }
  const pick = (k: Source) => {
    if (busy) return;
    source = k;
    quote = null;
    error = '';
    request++; // any reply still out is for the old choice
  };

  // NEAR's mark: lib/chains.ts MARKS (@web3icons/core, MIT), the same one the header and landing use.
  const SOURCES = $derived([['near', 'NEAR', markLogo(MARKS.near)], ...FUNDING_CHAINS.map((c) => [c.key, c.name, chainLogo(c)])] as [Source, string, string][]);
  function sourceKey(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    if (busy) return;
    const i = SOURCES.findIndex(([k]) => k === source);
    pick(SOURCES[(i + d + SOURCES.length) % SOURCES.length][0]);
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
    <div class="text-sm text-zen-fg-subtle shrink-0">{label}</div>
    <div class="font-medium text-sm text-right tabular-nums" title={exact || undefined}>{value}</div>
  </div>
{/snippet}

<div class="flex flex-col gap-4" data-fund>
  {#if saved && chain}
    <!-- A deposit address is out: follow it until 1Click reports a final status -->
    <div class="flex flex-col gap-4 pt-4 border-t border-zen-border-subtle">
      <p class="text-sm text-zen-fg">From {chain.name}</p>
      {@render row('You Send', `${saved.amountInFormatted} USDC on ${chain.name}`)}
      {@render row('You Get', `${usdc(saved.amountOut)} USDC on NEAR`)}
      {@render row('Fee', `${usdc(feeOf(saved.amountIn, saved.amountOut))} USDC`)}
      {@render row('Send Before', when(saved.deadline))}
      {#if canPay}
        <!-- the address only while nothing is seen, before its deadline, and after 1Click answered: never invite a second payment -->
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
        <p class="flex items-center gap-2 text-sm text-zen-fg-muted" role="status"><Clock class="w-4 h-4 shrink-0" aria-hidden="true" />{fresh ? `Waiting for your USDC on ${chain.name}.` : 'Checking with 1Click…'}</p>
      {/if}
      {#if expired}
        <Note tone="error">This deposit address has expired. Don't send anything to it.</Note>
      {/if}
      {#if stalled}
        <div class="flex flex-wrap items-center justify-between gap-x-3">
          <p class="text-xs text-zen-fg-subtle">Stopped checking after an hour. 1Click still has it.</p>
          <ZenButton variant="ghost" size="sm" onclick={() => saved && follow(saved)}>Check Again</ZenButton>
        </div>
      {/if}
      {#if error && saved}<Note tone="error">{error}</Note>{/if}
      {#if canStartOver}
        <div class="flex flex-wrap gap-2">
          <ZenButton variant="ghost" size="sm" onclick={startOver}>{line?.done ? 'Done' : 'Start Over'}</ZenButton>
        </div>
      {/if}
    </div>
  {/if}
  {#if earlier.length && !saved}
    <div class="flex flex-col gap-1 text-xs text-zen-fg-subtle">
      {#each earlier as e (e.depositAddress)}
        <p class="break-all">Earlier address, expired: <span class="font-mono">{e.depositAddress}</span>. If you sent USDC to it, the outcome is unknown here: ask 1Click support with this address. Refund address on record: <span class="font-mono">{e.refundTo}</span>.</p>
      {/each}
    </div>
  {/if}
  {#if !saved}
    <div class="flex flex-col gap-3">
      <div class="text-sm text-zen-fg-muted" id="pay-with">Pay With</div>
      <div role="radiogroup" aria-labelledby="pay-with" tabindex="-1" class="grid grid-cols-5 gap-1.5" onkeydown={sourceKey}>
        {#each SOURCES as [k, label, logo] (k)}
          <button
            type="button"
            role="radio"
            aria-checked={source === k}
            tabindex={source === k ? 0 : -1}
            data-source={k}
            disabled={busy}
            class="flex flex-col items-center gap-1 py-2 rounded-xl text-[11px] font-medium transition-colors {source === k ? 'bg-zen-fg/10 text-zen-fg' : 'text-zen-fg-muted hover:text-zen-fg'}"
            onclick={() => pick(k)}
          ><span class="w-6 h-6 [&>svg]:w-full [&>svg]:h-full" aria-hidden="true">{@html logo}</span><span class="w-full truncate text-center">{label}</span
            >{#if testnet && k !== 'near'}<ZenBadge size="sm">Mainnet</ZenBadge>{/if}</button>
        {/each}
      </div>
    </div>
    {#if chain && need === 0n}
      <p class="text-sm text-zen-fg-muted">Nothing to bring from {chain.name}: your NEAR account already holds enough USDC.</p>
    {:else if chain}
      {#if testnet}
        <Note tone="info">1Click has no testnet. Here you see the live mainnet price. On testnet, pay with Test USDC on NEAR.</Note>
      {/if}
      {#if ownRefund}
        <p class="text-sm text-zen-fg-muted">Refunds go to your own account, <span class="font-mono text-zen-fg" title={ownRefund}>{middle(ownRefund, 6)}</span>, on {chain.name}.</p>
      {:else}
        <ZenInput label="Your {chain.name} Address" hint="Refunds go here. Your own wallet, not an exchange." placeholder={chain.placeholder} bind:value={refundTo} error={addrError} disabled={busy} autocomplete="off" spellcheck="false" />
        {#if refundTo && !addrError}
          <ZenInput label="Its Last 6 Characters" hint="Read it again from your wallet." bind:value={last6} maxlength={6} disabled={busy} autocomplete="off" spellcheck="false" class="font-mono" />
        {/if}
      {/if}
      <div class="flex flex-wrap items-center gap-3">
        <ZenButton variant="secondary" size="sm" onclick={ask} disabled={!confirmed || busy}>
          {#snippet iconLeft()}<ArrowLeftRight class="w-3.5 h-3.5" />{/snippet}{busy ? 'Getting Quote…' : quote ? 'New Quote' : 'Get Quote'}
        </ZenButton>
        <span class="text-xs text-zen-fg-subtle tabular-nums">For the {formatAmount(need)} USDC still needed</span>
      </div>
      {#if error}<Note tone="error">{error}</Note>{/if}
      {#if quote && testnet}
        <div class="flex flex-col gap-3 pt-4 border-t border-zen-border-subtle" data-quote>
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
