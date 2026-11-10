<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { getConfig, getPrepayBalance, txOutcome, type ContractConfig } from '$lib/create/chain';
  import { claimedAmount, formatNear, listCampaigns, reclaimable, reclaimOutcome, reclaimTx, withdrawTx, type CampaignView } from '$lib/create/campaigns';
  import { formatAmount } from '$lib/create/recipients';
  import { myNearWallet, type SenderWallet } from '$lib/create/wallet';
  import { nearView } from '$lib/services';
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
  let error = $state('');
  let note = $state('');
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
    try {
      account = await wallet!.signIn();
      await load();
    } catch (e) {
      error = `Wallet: ${(e as Error).message}`;
    }
  }

  /** Sends one tx, waits for its outcome, then re-reads everything from the chain. */
  async function run(label: string, tx: ReturnType<typeof reclaimTx>, campaignId?: string) {
    error = note = '';
    busy = label;
    try {
      const [hash] = await wallet!.send([tx]);
      busy = 'Waiting for the transaction…';
      const outcome = (await txOutcome(rpc!, hash, account!)) as Parameters<typeof reclaimOutcome>[0];
      if (campaignId) {
        const r = reclaimOutcome(outcome, contract!, campaignId);
        note =
          r.kind === 'reclaimed' ? `Reclaimed ${formatAmount(BigInt(r.amount))} USDC.`
          : r.kind === 'reverted' ? 'The transfer failed; your balance is back. Try again.'
          : r.kind === 'failed' ? `The transaction did not go through (${r.code}).`
          : 'Done: the unused storage reservation is back in your free pre-pay.';
      } else {
        const failure = outcome.receipts_outcome?.find((r) => r.outcome?.status?.Failure !== undefined)?.outcome?.status?.Failure;
        const code = failure ? (/E1\d\d_[A-Z_]+/.exec(JSON.stringify(failure))?.[0] ?? 'FAILED') : null;
        note = code ? `The transaction did not go through (${code}).` : 'Done.';
      }
      if (env.PUBLIC_EXPLORER_TX_URL) note += ` Transaction: ${env.PUBLIC_EXPLORER_TX_URL}${hash}`;
    } catch (e) {
      error = `Wallet: ${(e as Error).message}. Check your campaigns below before trying again.`;
    } finally {
      busy = '';
      await load();
    }
  }

  const fmtDate = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString();
</script>

<svelte:head><title>Your campaigns · Zarf</title></svelte:head>

<div class="w-full max-w-3xl mx-auto px-4 sm:px-6 py-8 md:py-12">
  <!-- PageHeader (main repo) -->
  <header class="mb-10 flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
    <div class="space-y-2">
      <h1 class="text-2xl md:text-3xl font-light tracking-tight">Your campaigns</h1>
      <p class="text-sm md:text-base text-zen-fg-muted font-light">After the deadline, take back what was not claimed.</p>
    </div>
    <a href="/create" class="inline-flex items-center min-h-11 text-xs font-medium no-underline text-zen-fg-muted hover:text-zen-fg">Create a campaign</a>
  </header>

  {#if setupError}
    <p class="text-sm text-zen-error" role="alert">{setupError}</p>
  {:else if !account}
    <div class="flex flex-col items-start gap-3">
      <p class="text-sm text-zen-fg-muted">Connect the wallet you sent from.</p>
      <ZenButton variant="primary" class="rounded-full min-h-11" onclick={connect} disabled={!walletReady}>Connect MyNearWallet</ZenButton>
    </div>
  {:else}
    <div class="flex flex-col gap-1 pb-6 mb-8 border-b-[0.5px] border-zen-border-subtle">
      <p class="text-sm text-zen-fg-muted">Sender <span class="font-mono text-zen-fg">{account}</span></p>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="text-sm"><span class="font-semibold tabular-nums">{formatNear(freePrepay)} NEAR</span> <span class="text-zen-fg-muted">free storage pre-pay, not reserved by any campaign</span></h2>
        <ZenButton variant="secondary" size="sm" class="rounded-full min-h-11" disabled={BigInt(freePrepay) === 0n || !!busy} onclick={() => run('Withdrawing…', withdrawTx(account!, contract!))}>Withdraw free pre-pay</ZenButton>
      </div>
    </div>

    <h2 class="text-sm font-medium mb-4">Campaigns</h2>
    {#if rows === null}
      <p class="text-sm text-zen-fg-muted" role="status">Loading…</p>
    {:else if rows.length === 0}
      <p class="text-sm text-zen-fg-muted">No campaigns from this account yet.</p>
    {:else}
      <div class="flex flex-col gap-4">
        {#each rows as r (r.id)}
          {@const can = reclaimable(r.c, now)}
          {@const claimed = claimedAmount(r.c)}
          {@const total = BigInt(r.c.amount)}
          <ZenCard variant="elevated" padding="md" radius="2xl">
            <section class="flex flex-col gap-4" aria-label="Campaign {r.id}">
              <div class="flex items-baseline justify-between gap-3">
                <h3 class="text-base font-semibold">Campaign {r.id}</h3>
                <span class="text-xl font-bold tracking-tight tabular-nums">{formatAmount(total)} USDC</span>
              </div>
              <!-- Claimed share of the campaign: the value, shown -->
              <div class="h-1 rounded-full bg-zen-fg/10 overflow-hidden" aria-hidden="true">
                <div class="h-full bg-zen-fg rounded-full" style="width: {total === 0n ? 0 : Number((claimed * 100n) / total)}%"></div>
              </div>
              <dl class="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-3 text-sm">
                <div><dt class="text-xs text-zen-fg-muted">Claimed</dt><dd class="tabular-nums">{formatAmount(claimed)} USDC</dd></div>
                <div><dt class="text-xs text-zen-fg-muted">Balance</dt><dd class="tabular-nums">{formatAmount(BigInt(r.c.balance))} USDC</dd></div>
                <div><dt class="text-xs text-zen-fg-muted">In flight</dt><dd class="tabular-nums">{formatAmount(BigInt(r.c.in_flight))} USDC</dd></div>
                <div><dt class="text-xs text-zen-fg-muted">Storage reserved</dt><dd class="tabular-nums">{formatNear(r.c.storage_reserved)} NEAR</dd></div>
                <div class="col-span-2 sm:col-span-4"><dt class="text-xs text-zen-fg-muted">Deadline</dt><dd>{fmtDate(r.c.deadline_ns)}</dd></div>
              </dl>
              <div class="flex flex-wrap items-center gap-3">
                <ZenButton variant={can.ok ? 'primary' : 'secondary'} size="sm" class="rounded-full min-h-11" disabled={!can.ok || !!busy} onclick={() => run(`Reclaiming campaign ${r.id}…`, reclaimTx(account!, contract!, r.id), r.id)}>Reclaim</ZenButton>
                {#if !can.ok}<p class="text-xs text-zen-fg-muted">{can.reason}</p>{/if}
              </div>
            </section>
          </ZenCard>
        {/each}
      </div>
    {/if}
  {/if}

  <div class="mt-6 flex flex-col gap-2 text-sm">
    {#if busy}<p role="status">{busy}</p>{/if}
    {#if note}<p role="status" class="break-all">{note}</p>{/if}
    {#if error}<p class="text-zen-error" role="alert">{error}</p>{/if}
  </div>
</div>
