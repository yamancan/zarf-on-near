<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { getConfig, getPrepayBalance, txOutcome, type ContractConfig } from '$lib/create/chain';
  import { claimedAmount, formatNear, listCampaigns, reclaimable, reclaimOutcome, reclaimTx, withdrawTx, type CampaignView } from '$lib/create/campaigns';
  import { formatAmount } from '$lib/create/recipients';
  import { nearConnectWallet, type SenderWallet } from '$lib/create/wallet';
  import { readSentOutcome } from '$lib/create/funding';
  import { nearView } from '$lib/services';
  import { deadlineText, timeLeft } from '$lib/claim';
  import { UNIT } from '$lib/network';
  import { ArrowDownToLine, ArrowUpRight, ChevronDown, Info, Plus, Send, Wallet } from 'lucide-svelte';
  import Avatar from '$lib/Avatar.svelte';
  import { titleCase } from '$lib/text';
  import Tooltip from '$lib/zarf-kit/components/ui/Tooltip.svelte';
  import ZenBadge from '$lib/zarf-kit/components/ui/ZenBadge.svelte';
  import Medallion from '$lib/Medallion.svelte';
  import Note from '$lib/Note.svelte';
  import PageHeader from '$lib/zarf-kit/components/ui/PageHeader.svelte';
  import ZenAlert from '$lib/zarf-kit/components/ui/ZenAlert.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import ZenCard from '$lib/zarf-kit/components/ui/ZenCard.svelte';

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
  let result = $state<{ for: string; tone: 'success' | 'error' | 'info'; text: string; code?: string; hash?: string } | null>(null);
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
      wallet = await nearConnectWallet(config.network, rpc);
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
    let hash: string | undefined;
    try {
      [hash] = await wallet!.send([tx]);
      busy = 'Waiting for the transaction…';
      // Retried like /create's lookup; a read that never succeeds is "sent, not read", never "not sent" (T-012 finding 6).
      const read = await readSentOutcome({ outcome: (h) => txOutcome(rpc!, h, account!) }, hash);
      if (!read) {
        result = { for: target, tone: 'info', text: 'Sent; result not read yet. Check the transaction, then reload.', hash };
        return;
      }
      const outcome = read as Parameters<typeof reclaimOutcome>[0];
      if (campaignId) {
        const r = reclaimOutcome(outcome, contract!, campaignId);
        result =
          r.kind === 'reclaimed' ? { for: target, tone: 'success', text: `${formatAmount(BigInt(r.amount))} ${UNIT} is back in your wallet. Any unused storage NEAR moved to your Zarf balance below.`, hash }
          : r.kind === 'reverted' ? { for: target, tone: 'error', text: 'The transfer failed; the balance is back in the campaign. Try again.', hash }
          : r.kind === 'failed' ? { for: target, tone: 'error', text: 'The transaction did not go through.', code: r.code, hash }
          : { for: target, tone: 'success', text: 'The unused storage NEAR is back in your Zarf balance.', hash };
      } else {
        const failure = outcome.receipts_outcome?.find((r) => r.outcome?.status?.Failure !== undefined)?.outcome?.status?.Failure;
        const code = failure ? (/E1\d\d_[A-Z_]+/.exec(JSON.stringify(failure))?.[0] ?? 'FAILED') : null;
        result = code ? { for: target, tone: 'error', text: 'The transaction did not go through.', code, hash } : { for: target, tone: 'success', text: 'Withdrawn to your wallet.', hash };
      }
    } catch (e) {
      result = hash
        ? { for: target, tone: 'info', text: 'Sent; result not read yet. Check the transaction, then reload.', hash }
        : (e as Error).message === 'ACCOUNT_CHANGED'
          ? { for: target, tone: 'error', text: 'Nothing was sent: your wallet switched to another account. Reconnect it and try again.' }
          : { for: target, tone: 'error', text: 'The wallet did not send it. Check this campaign before trying again.' };
    } finally {
      busy = '';
      await load();
    }
  }
</script>

<svelte:head><title>My Campaigns · Zarf</title></svelte:head>

{#snippet outcome(target: string)}
  {#if busy && acting === target}
    <Note tone="pending">{busy}</Note>
  {:else if result?.for === target}
    <Note tone={result.tone}>{result.text}</Note>
    {#if result.code}
      <details class="group text-xs text-zen-fg-muted">
        <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
        <p class="text-xs text-zen-fg-muted">Code <span class="font-mono">{result.code}</span></p>
      </details>
    {/if}
    {#if result.hash && env.PUBLIC_EXPLORER_TX_URL}
      <a href="{env.PUBLIC_EXPLORER_TX_URL}{result.hash}" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-xs text-zen-fg-muted underline underline-offset-2 hover:text-zen-fg">View Transaction<ArrowUpRight class="w-3 h-3" aria-hidden="true" /></a>
    {/if}
  {/if}
{/snippet}

<!-- Zarf's distributions page frame (apps/create/src/routes/distributions/+page.svelte:126-151): max-w-7xl, the page's own
     gutters, a header row with PageHeader on the left and the primary action on the right -->
<div class="max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 h-full flex flex-col gap-8">
  <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-6">
  <PageHeader title="My Campaigns" description="Claims, deadlines and take-backs." />
    <div class="flex flex-wrap items-center justify-between sm:justify-end gap-4">
      <!-- The connected account sits beside the primary action, where Zarf's navbar keeps its wallet button -->
      {#if account}
        <span class="flex items-center gap-2 text-sm">
          <Avatar name={account} /><span class="hidden sm:inline font-mono truncate max-w-40">{account}</span>
          <ZenButton variant="ghost" size="sm" disabled={!!busy} onclick={async () => { await wallet?.signOut(); account = null; rows = null; }}>Disconnect</ZenButton>
        </span>
      {/if}
    <a href="/create" class="inline-block"><ZenButton tabindex={-1} variant="primary" size="lg">
      {#snippet iconLeft()}<Plus class="w-4 h-4" />{/snippet}New Send
    </ZenButton></a>
    </div>
  </div>

  {#if setupError}
    <ZenAlert variant="error">{setupError}</ZenAlert>
  {:else if !walletReady}
    <Note tone="pending">Loading…</Note>
  {:else if !account}
    <ZenCard variant="elevated" padding="lg" class="max-w-lg mx-auto">
      <div class="flex flex-col items-center text-center space-y-6 py-2">
        <Medallion icon={Wallet} />
        <div class="space-y-2">
          <h2 class="text-xl font-bold">Connect Wallet</h2>
          <p class="text-sm text-zen-fg-muted max-w-xs">The wallet you sent from.</p>
        </div>
        <ZenButton variant="primary" onclick={connect} disabled={!walletReady}>Connect Wallet</ZenButton>
        {#if walletError}<Note tone="error">{walletError}</Note>{/if}
      </div>
    </ZenCard>
  {:else if error}
    <ZenAlert variant="error">
      {error}
      {#snippet actions()}<ZenButton variant="secondary" size="sm" onclick={load}>Try Again</ZenButton>{/snippet}
    </ZenAlert>
  {:else if rows === null}
    <Note tone="pending">Loading your campaigns…</Note>
  {:else if rows.length === 0}
    <ZenCard variant="elevated" padding="lg" class="max-w-lg mx-auto">
      <div class="flex flex-col items-center text-center space-y-6 py-2">
        <Medallion icon={Send} tone="muted" />
        <div class="space-y-2">
          <h2 class="text-xl font-bold">No Campaigns Yet</h2>
          <p class="text-sm text-zen-fg-muted">Nothing sent from <span class="font-mono">{account}</span> so far.</p>
        </div>
        <a href="/create" class="inline-block"><ZenButton tabindex={-1} variant="primary">Send USDC</ZenButton></a>
      </div>
    </ZenCard>
  {:else}
    <!-- Rows, not cards (design spec 3.7) -->
    <div class="divide-y divide-zen-border-subtle border-y border-zen-border-subtle">
      {#each rows as r (r.id)}
        {@const can = reclaimable(r.c, now)}
        {@const claimed = claimedAmount(r.c)}
        {@const total = BigInt(r.c.amount)}
        {@const ms = Number(BigInt(r.c.deadline_ns) / 1_000_000n)}
        {@const left = timeLeft(ms, now)}
        <section class="py-6 flex flex-col gap-4" aria-label="Campaign {r.id}">
          <div class="flex items-center justify-between gap-3">
            <span class="zen-section-label !text-zen-fg-subtle !mb-0">Campaign {r.id}</span>
            <span title={deadlineText(ms, now)}>
              {#if left}<ZenBadge variant="default" size="sm">{titleCase(left)}</ZenBadge>{:else}<ZenBadge variant="warning" size="sm">Claims Closed</ZenBadge>{/if}
            </span>
          </div>
          <span class="flex items-baseline gap-2"><span class="text-3xl font-light tracking-tighter tabular-nums">{formatAmount(total)}</span><span class="text-xs font-medium uppercase tracking-widest text-zen-primary whitespace-nowrap">{UNIT}</span></span>
          <!-- Claimed share of the campaign: the value, shown -->
          <div class="flex flex-col gap-2">
            <div class="h-1 rounded-full bg-zen-fg/10 overflow-hidden" aria-hidden="true">
              <div class="h-full bg-zen-fg rounded-full" style="width: {total === 0n ? 0 : Number((claimed * 100n) / total)}%"></div>
            </div>
            <p class="text-sm text-zen-fg-muted tabular-nums">{formatAmount(claimed)} of {formatAmount(total)} claimed</p>
          </div>
          <details class="group text-xs text-zen-fg-subtle">
            <summary class="inline-flex items-center gap-1.5 py-1 cursor-pointer list-none hover:text-zen-fg">Details <ChevronDown class="w-3.5 h-3.5 transition-transform group-open:rotate-180" aria-hidden="true" /></summary>
            <div class="grid grid-cols-1 gap-2 pt-2">
              <div class="flex justify-between gap-4"><span class="text-[10px] uppercase">Not Claimed Yet</span><span class="tabular-nums text-sm text-zen-fg">{formatAmount(BigInt(r.c.balance))} {UNIT}</span></div>
              <div class="flex justify-between gap-4"><span class="text-[10px] uppercase">Being Paid Now</span><span class="tabular-nums text-sm text-zen-fg">{formatAmount(BigInt(r.c.in_flight))} {UNIT}</span></div>
              <div class="flex justify-between gap-4"><span class="text-[10px] uppercase">Storage for Open Links</span><span class="tabular-nums text-sm text-zen-fg">{formatNear(r.c.storage_reserved)} NEAR</span></div>
              <div class="flex justify-between gap-4"><span class="text-[10px] uppercase">Claims Close</span><span class="text-sm text-zen-fg text-right">{deadlineText(ms, now)}</span></div>
            </div>
          </details>
          <div class="flex flex-col items-start gap-2">
            {#if result?.for === r.id && result.tone === 'success'}
              <!-- Done: the outcome below says what came back; no live button to press again -->
            {:else if can.ok}
              <ZenButton variant="tonal" size="sm" disabled={!!busy} onclick={() => run('Reclaiming…', reclaimTx(account!, contract!, r.id), r.id, r.id)}>{BigInt(r.c.balance) === 0n ? 'Move Storage to Balance' : `Take Back ${formatAmount(BigInt(r.c.balance))} ${UNIT}`}</ZenButton>
            {:else}
              <p class="text-xs text-zen-fg-subtle">{left ? `After ${deadlineText(ms, ms)} you can take back what's left.` : can.reason}</p>
            {/if}
            {@render outcome(r.id)}
          </div>
          <a href="/create#backup" class="self-start text-xs text-zen-fg-subtle underline underline-offset-2 hover:text-zen-fg">Lost the links? Open your backup</a>
        </section>
      {/each}
    </div>

    <!-- The sender's Zarf balance (the contract's free pre-pay): a footer row -->
    <div class="mt-8 flex flex-col items-start gap-2">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span class="tabular-nums" title="{formatNear(freePrepay)} NEAR">{formatNear(freePrepay)} NEAR</span>
        <span class="inline-flex items-center gap-1 text-zen-fg-muted">Zarf Balance
          <Tooltip text="NEAR held for storage; the rest is yours." position="top">
            <button type="button" class="inline-flex items-center justify-center w-6 h-6 rounded-full text-zen-fg-subtle hover:text-zen-fg" aria-label="What is my Zarf balance: NEAR you keep at the Zarf contract to pay for storage. Each send draws on it; what is left is yours."><Info class="w-3.5 h-3.5" aria-hidden="true" /></button>
          </Tooltip>
        </span>
        {#if BigInt(freePrepay) > 0n && !(result?.for === 'prepay' && result.tone === 'success')}
          <ZenButton variant="ghost" size="sm" disabled={!!busy} onclick={() => run('Withdrawing…', withdrawTx(account!, contract!), 'prepay')}>{#snippet iconLeft()}<ArrowDownToLine class="w-3.5 h-3.5" />{/snippet}Withdraw</ZenButton>
        {/if}
      </div>
      {@render outcome('prepay')}
    </div>
  {/if}
</div>
