<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { getConfig, getPrepayBalance, txOutcome, type ContractConfig } from '$lib/create/chain';
  import { claimedAmount, formatNear, listCampaigns, reclaimable, reclaimOutcome, reclaimTx, withdrawTx, type CampaignView } from '$lib/create/campaigns';
  import { formatAmount } from '$lib/create/recipients';
  import { myNearWallet, type SenderWallet } from '$lib/create/wallet';
  import { nearView } from '$lib/services';
  import { deadlineText, timeLeft } from '$lib/claim';
  import { UNIT } from '$lib/network';
  import { ArrowUpRight, ChevronDown, Send, Wallet } from 'lucide-svelte';
  import Medallion from '$lib/Medallion.svelte';
  import Note from '$lib/Note.svelte';
  import PageHeader from '$lib/zen/components/PageHeader.svelte';
  import ZenAlert from '$lib/zen/components/ZenAlert.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import ZenCard from '$lib/zen/components/ZenCard.svelte';

  const rpc = env.PUBLIC_NEAR_RPC_URL;
  const contract = env.PUBLIC_CONTRACT_ID;

  let config = $state<ContractConfig | null>(null);
  let setupError = $state('');
  let wallet: SenderWallet | null = null;
  let walletReady = $state(false);
  let account = $state<string | null>(null);
  let rows = $state<{ id: string; c: CampaignView }[] | null>(null);
  let freePrepay = $state('0');
  let busy = $state('');
  let error = $state(''); // loading the list
  // The outcome of the last action, shown under the button that started it ('prepay' or a campaign id).
  let result = $state<{ for: string; tone: 'success' | 'error'; text: string; code?: string; hash?: string } | null>(null);
  let acting = $state('');
  let walletError = $state('');
  let now = $state(Date.now());

  const view = <T,>(method: string, args: object) => nearView<T>(rpc!, contract!, method, args, 'optimistic');

  onMount(async () => {
    if (!rpc || !contract) {
      setupError = 'This site is not fully set up yet (PUBLIC_NEAR_RPC_URL, PUBLIC_CONTRACT_ID).';
      return;
    }
    try {
      config = await getConfig(rpc, contract);
      wallet = await myNearWallet(config.network, rpc);
      walletReady = true;
      account = wallet.accountId();
      if (account) await load();
    } catch {
      setupError = 'Could not read the contract. Try again in a minute.';
    }
  });

  async function load() {
    error = '';
    now = Date.now();
    try {
      const [list, free] = await Promise.all([listCampaigns(view, account!), getPrepayBalance(rpc!, contract!, account!)]);
      freePrepay = free;
      rows = list;
    } catch {
      error = 'Could not load your campaigns. Try again in a minute.';
    }
  }

  async function connect() {
    walletError = '';
    try {
      account = await wallet!.signIn();
    } catch {
      walletError = 'The wallet did not connect. Try again.';
      return;
    }
    await load();
  }

  /** Sends one tx, waits for its outcome, then re-reads everything from the chain. */
  async function run(label: string, tx: ReturnType<typeof reclaimTx>, target: string, campaignId?: string) {
    result = null;
    acting = target;
    busy = label;
    try {
      const [hash] = await wallet!.send([tx]);
      busy = 'Waiting for the transaction…';
      const outcome = (await txOutcome(rpc!, hash, account!)) as Parameters<typeof reclaimOutcome>[0];
      if (campaignId) {
        const r = reclaimOutcome(outcome, contract!, campaignId);
        result =
          r.kind === 'reclaimed' ? { for: target, tone: 'success', text: `Reclaimed ${formatAmount(BigInt(r.amount))} ${UNIT}.`, hash }
          : r.kind === 'reverted' ? { for: target, tone: 'error', text: 'The transfer failed; the balance is back in the campaign. Try again.', hash }
          : r.kind === 'failed' ? { for: target, tone: 'error', text: 'The transaction did not go through.', code: r.code, hash }
          : { for: target, tone: 'success', text: 'The unused storage is back in your storage deposit.', hash };
      } else {
        const failure = outcome.receipts_outcome?.find((r) => r.outcome?.status?.Failure !== undefined)?.outcome?.status?.Failure;
        const code = failure ? (/E1\d\d_[A-Z_]+/.exec(JSON.stringify(failure))?.[0] ?? 'FAILED') : null;
        result = code ? { for: target, tone: 'error', text: 'The transaction did not go through.', code, hash } : { for: target, tone: 'success', text: 'Withdrawn to your wallet.', hash };
      }
    } catch {
      result = { for: target, tone: 'error', text: 'The wallet did not send it. Check this campaign before trying again.' };
    } finally {
      busy = '';
      await load();
    }
  }
</script>

<svelte:head><title>Your campaigns · Zarf</title></svelte:head>

{#snippet outcome(target: string)}
  {#if busy && acting === target}
    <Note tone="pending">{busy}</Note>
  {:else if result?.for === target}
    <Note tone={result.tone}>{result.text}</Note>
    {#if result.code}
      <details class="group text-xs text-zen-fg-muted">
        <summary class="inline-flex items-center gap-1.5 min-h-11 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
        <p>Code <span class="font-mono">{result.code}</span></p>
      </details>
    {/if}
    {#if result.hash && env.PUBLIC_EXPLORER_TX_URL}
      <a href="{env.PUBLIC_EXPLORER_TX_URL}{result.hash}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 min-h-11 text-xs text-zen-fg-muted underline underline-offset-2 hover:text-zen-fg">View the transaction<ArrowUpRight class="w-3 h-3" aria-hidden="true" /></a>
    {/if}
  {/if}
{/snippet}

<div class="w-full max-w-3xl mx-auto px-6 py-8 md:py-12">
  <PageHeader title="Your campaigns" description="After the deadline, take back what was not claimed." />

  {#if setupError}
    <ZenAlert variant="error">{setupError}</ZenAlert>
  {:else if !walletReady}
    <Note tone="pending">Loading…</Note>
  {:else if !account}
    <ZenCard variant="elevated" class="max-w-lg mx-auto !p-6 sm:!p-8">
      <div class="flex flex-col items-center text-center gap-4 py-2">
        <Medallion icon={Wallet} />
        <h2 class="text-xl font-semibold tracking-tight">Connect the wallet you sent from</h2>
        <p class="text-sm text-zen-fg-muted max-w-xs">Your campaigns, what was claimed, and what you can take back.</p>
        <ZenButton variant="primary" class="rounded-full min-h-11 mt-2" onclick={connect} disabled={!walletReady}>Connect MyNearWallet</ZenButton>
        {#if walletError}<Note tone="error">{walletError}</Note>{/if}
      </div>
    </ZenCard>
  {:else if error}
    <ZenAlert variant="error">
      {error}
      {#snippet actions()}<ZenButton variant="secondary" size="sm" class="rounded-full min-h-11" onclick={load}>Try again</ZenButton>{/snippet}
    </ZenAlert>
  {:else if rows === null}
    <Note tone="pending">Loading your campaigns…</Note>
  {:else if rows.length === 0}
    <ZenCard variant="elevated" class="max-w-lg mx-auto !p-6 sm:!p-8">
      <div class="flex flex-col items-center text-center gap-4 py-2">
        <Medallion icon={Send} tone="muted" />
        <h2 class="text-xl font-semibold tracking-tight">No campaigns yet</h2>
        <p class="text-sm text-zen-fg-muted">Nothing sent from <span class="font-mono">{account}</span> so far.</p>
        <ZenButton href="/create" variant="primary" class="rounded-full min-h-11 mt-2">Send USDC</ZenButton>
      </div>
    </ZenCard>
  {:else}
    <p class="text-sm text-zen-fg-muted mb-6">Sent from <span class="font-mono text-zen-fg">{account}</span></p>
    <div class="flex flex-col gap-4">
      {#each rows as r (r.id)}
        {@const can = reclaimable(r.c, now)}
        {@const claimed = claimedAmount(r.c)}
        {@const total = BigInt(r.c.amount)}
        {@const ms = Number(BigInt(r.c.deadline_ns) / 1_000_000n)}
        {@const left = timeLeft(ms, now)}
        <ZenCard variant="elevated" padding="md">
          <section class="flex flex-col gap-4" aria-label="Campaign {r.id}">
            <div class="flex items-start justify-between gap-3">
              <div class="flex flex-col gap-1">
                <span class="text-[10px] font-medium uppercase tracking-[0.15em] text-zen-fg-muted">Campaign {r.id}</span>
                <span class="flex items-baseline gap-2"><span class="text-3xl font-light tracking-tighter tabular-nums">{formatAmount(total)}</span><span class="text-xs font-medium uppercase tracking-widest text-zen-primary whitespace-nowrap">{UNIT}</span></span>
              </div>
              <span class="text-xs text-zen-fg-muted pt-1" title={deadlineText(ms, now)}>{left || 'Claims closed'}</span>
            </div>
            <!-- Claimed share of the campaign: the value, shown -->
            <div class="flex flex-col gap-2">
              <div class="h-1 rounded-full bg-zen-fg/10 overflow-hidden" aria-hidden="true">
                <div class="h-full bg-zen-fg rounded-full" style="width: {total === 0n ? 0 : Number((claimed * 100n) / total)}%"></div>
              </div>
              <p class="text-sm"><span class="tabular-nums">{formatAmount(claimed)}</span> <span class="text-zen-fg-muted">of {formatAmount(total)} {UNIT} claimed</span></p>
            </div>
            <details class="group text-xs text-zen-fg-muted">
              <summary class="inline-flex items-center gap-1.5 min-h-11 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
              <dl class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
                <dt>Left in the campaign</dt><dd class="tabular-nums text-zen-fg">{formatAmount(BigInt(r.c.balance))} {UNIT}</dd>
                <dt>Being paid now</dt><dd class="tabular-nums text-zen-fg">{formatAmount(BigInt(r.c.in_flight))} {UNIT}</dd>
                <dt>Storage reserved</dt><dd class="tabular-nums text-zen-fg">{formatNear(r.c.storage_reserved)} NEAR</dd>
                <dt>Claim deadline</dt><dd class="text-zen-fg">{deadlineText(ms, now)}</dd>
              </dl>
            </details>
            <div class="flex flex-col items-start gap-2">
              {#if result?.for === r.id && result.tone === 'success'}
                <!-- Done: the outcome below says what came back; no live button to press again -->
              {:else if can.ok}
                <ZenButton variant="primary" size="sm" class="rounded-full min-h-11" disabled={!!busy} onclick={() => run('Reclaiming…', reclaimTx(account!, contract!, r.id), r.id, r.id)}>{BigInt(r.c.balance) === 0n ? 'Release storage' : 'Reclaim'}</ZenButton>
              {:else}
                <p class="text-xs text-zen-fg-muted">{left ? 'You can reclaim what is left once claims close.' : can.reason}</p>
              {/if}
              {@render outcome(r.id)}
            </div>
          </section>
        </ZenCard>
      {/each}
    </div>

    <!-- The sender's storage deposit (the contract's free pre-pay): a footer line, not the page's first block -->
    <div class="mt-8 pt-6 border-t-[0.5px] border-zen-border-subtle flex flex-col items-start gap-2">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span><span class="tabular-nums">{formatNear(freePrepay)} NEAR</span> <span class="text-zen-fg-muted">storage deposit</span></span>
        {#if BigInt(freePrepay) > 0n}
          <ZenButton variant="ghost" size="sm" class="rounded-full min-h-11 !text-zen-fg" disabled={!!busy} onclick={() => run('Withdrawing…', withdrawTx(account!, contract!), 'prepay')}>Withdraw</ZenButton>
        {/if}
      </div>
      {@render outcome('prepay')}
    </div>
  {/if}
</div>
