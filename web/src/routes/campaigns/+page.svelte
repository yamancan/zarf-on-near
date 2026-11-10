<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { getConfig, getPrepayBalance, txOutcome, type ContractConfig } from '$lib/create/chain';
  import { claimCounts, formatNear, listCampaigns, reclaimable, reclaimOutcome, reclaimTx, withdrawTx, type CampaignView, type Counts } from '$lib/create/campaigns';
  import { formatAmount } from '$lib/create/recipients';
  import { myNearWallet, type SenderWallet } from '$lib/create/wallet';
  import { fetchLeaves, nearView } from '$lib/services';

  const rpc = env.PUBLIC_NEAR_RPC_URL;
  const contract = env.PUBLIC_CONTRACT_ID;

  let config = $state<ContractConfig | null>(null);
  let setupError = $state('');
  let wallet: SenderWallet | null = null;
  let walletReady = $state(false);
  let account = $state<string | null>(null);
  let rows = $state<{ id: string; c: CampaignView; counts: Counts | 'loading' }[] | null>(null);
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
      rows = list.map((r) => ({ ...r, counts: 'loading' as const }));
      // Counts are a nicety: from the public leaf list plus claim_state; "n/a" if either is unavailable.
      list.forEach(async (r, i) => {
        let counts: Counts = null;
        try {
          const file = await fetchLeaves(env.PUBLIC_LEAVES_URL, r.id);
          if (file.merkle_root === r.c.merkle_root) {
            counts = await claimCounts(file.leaves.map((l) => l.commitment), (commitment) => view<string>('claim_state', { campaign_id: r.id, commitment }));
          }
        } catch {
          counts = null;
        }
        if (rows?.[i]?.id === r.id) rows[i].counts = counts;
      });
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

<h1>Your campaigns</h1>
<p class="muted">
  After a campaign's deadline you can take back what was not claimed, plus the storage it reserved. <a href="/create">Create a campaign</a>
</p>

{#if setupError}
  <p class="error" role="alert">{setupError}</p>
{:else if !account}
  <button onclick={connect} disabled={!walletReady}>Connect MyNearWallet</button>
{:else}
  <p>Sender <code>{account}</code></p>

  <h2>Free storage pre-pay</h2>
  <p>{formatNear(freePrepay)} NEAR is not reserved by any campaign.</p>
  <button disabled={BigInt(freePrepay) === 0n || !!busy} onclick={() => run('Withdrawing…', withdrawTx(account!, contract!))}>Withdraw free pre-pay</button>

  <h2>Campaigns</h2>
  {#if rows === null}
    <p class="muted">Loading…</p>
  {:else if rows.length === 0}
    <p class="muted">No campaigns from this account yet.</p>
  {:else}
    {#each rows as r (r.id)}
      {@const can = reclaimable(r.c, now)}
      <section class="campaign" aria-label="Campaign {r.id}">
        <h3>Campaign {r.id} · {formatAmount(BigInt(r.c.amount))} USDC</h3>
        <dl>
          <dt>Deadline</dt><dd>{fmtDate(r.c.deadline_ns)}</dd>
          <dt>Claims</dt>
          <dd>
            {#if r.counts === 'loading'}…{:else if r.counts === null}n/a{:else}{r.counts.claimed} claimed, {r.counts.unclaimed} unclaimed{r.counts.pending ? `, ${r.counts.pending} pending` : ''}{/if}
          </dd>
          <dt>Balance</dt><dd>{formatAmount(BigInt(r.c.balance))} USDC</dd>
          <dt>In flight</dt><dd>{formatAmount(BigInt(r.c.in_flight))} USDC</dd>
          <dt>Storage reserved</dt><dd>{formatNear(r.c.storage_reserved)} NEAR</dd>
        </dl>
        <button disabled={!can.ok || !!busy} onclick={() => run(`Reclaiming campaign ${r.id}…`, reclaimTx(account!, contract!, r.id), r.id)}>Reclaim</button>
        {#if !can.ok}<p class="muted">{can.reason}</p>{/if}
      </section>
    {/each}
  {/if}
{/if}

{#if busy}<p role="status">{busy}</p>{/if}
{#if note}<p role="status">{note}</p>{/if}
{#if error}<p class="error" role="alert">{error}</p>{/if}

<style>
  .campaign {
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 12px 16px;
    margin: 12px 0;
  }
  h2 {
    font-size: 1.1rem;
    margin: 1.5rem 0 0.5rem;
  }
  h3 {
    font-size: 1rem;
    margin: 0 0 0.5rem;
  }
  dl {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 12px;
    margin: 0 0 12px;
  }
  dt {
    color: var(--muted);
  }
  dd {
    margin: 0;
  }
</style>
