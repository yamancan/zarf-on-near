<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { buildDraft, claimLink, leafList, recoveryFile, type Draft } from '$lib/create/campaign';
  import { getConfig, getPrepayBalance, getStorageCosts, txOutcome, type ContractConfig } from '$lib/create/chain';
  import { fundCampaign, minDeadlineMs } from '$lib/create/funding';
  import { downloadPublisher, saveFile } from '$lib/create/publish';
  import { formatAmount, parseRecipients } from '$lib/create/recipients';
  import { myNearWallet, type SenderWallet } from '$lib/create/wallet';

  const rpc = env.PUBLIC_NEAR_RPC_URL;
  const contract = env.PUBLIC_CONTRACT_ID;
  const token = env.PUBLIC_TOKEN_ID;

  let csv = $state('');
  const parsed = $derived(parseRecipients(csv));
  let config = $state<ContractConfig | null>(null);
  let setupError = $state('');
  let deadline = $state(''); // datetime-local, the sender's time zone
  let wallet: SenderWallet | null = null;
  let account = $state<string | null>(null);
  let draft = $state<Draft | null>(null);
  let recoverySaved = $state(false);
  let recoveryAck = $state(false);
  let busy = $state('');
  let error = $state('');
  let result = $state<{ campaignId: string; txHash: string } | null>(null);
  let publishTodo = $state<string | null>(null);
  let copied = $state(false);

  const toLocalInput = (ms: number) => new Date(ms - new Date(ms).getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const minMs = $derived(config ? minDeadlineMs(Date.now(), config.min_lifetime_ns) : null);
  const deadlineMs = $derived(deadline ? new Date(deadline).getTime() : NaN);
  const deadlineOk = $derived(minMs !== null && Number.isFinite(deadlineMs) && deadlineMs > minMs);
  const ready = $derived(parsed.rows.length > 0 && parsed.rejected.length === 0 && deadlineOk && !!account);
  const claimOrigin = env.PUBLIC_CLAIM_ORIGIN || (typeof location === 'undefined' ? '' : location.origin);
  const links = $derived(
    result && draft
      ? draft.recipients.map((r) => `${r.email},${formatAmount(BigInt(r.amount))},${claimLink(claimOrigin, result!.campaignId, r)}`)
      : [],
  );

  onMount(async () => {
    if (!rpc || !contract || !token) {
      setupError = 'This site is not fully set up yet (PUBLIC_NEAR_RPC_URL, PUBLIC_CONTRACT_ID, PUBLIC_TOKEN_ID).';
      return;
    }
    try {
      config = await getConfig(rpc, contract);
      if (!config.token_ids.includes(token)) setupError = `${token} is not accepted by this contract.`;
      deadline = toLocalInput(Math.max(Date.now() + 7 * 86_400_000, minDeadlineMs(Date.now(), config.min_lifetime_ns) + 3_600_000));
      wallet = await myNearWallet(config.network, rpc);
      account = wallet.accountId();
    } catch {
      setupError = 'Could not read the contract. Try again in a minute.';
    }
  });

  async function connect() {
    error = '';
    try {
      account = await wallet!.signIn();
    } catch (e) {
      error = `Wallet: ${(e as Error).message}`;
    }
  }

  async function disconnect() {
    await wallet!.signOut();
    account = null;
  }

  async function prepare() {
    error = '';
    draft = await buildDraft(parsed.rows);
    recoverySaved = recoveryAck = false;
  }

  function saveRecovery() {
    saveFile(`zarf-recovery-${draft!.merkleRoot.slice(0, 8)}.json`, recoveryFile(draft!, (BigInt(deadlineMs) * 1_000_000n).toString()));
    recoverySaved = true;
  }

  const ERRORS: Record<string, string> = {
    E119_INVALID_DEADLINE: 'The deadline is too early for this contract. Pick a later one.',
    E126_UNKNOWN_TOKEN: 'The contract does not accept this token.',
    E127_NO_VERIFIER: 'The contract has no verifier key that covers this deadline.',
    E128_INSUFFICIENT_STORAGE: 'The storage pre-pay was too low twice in a row. Your tokens were refunded; try again.',
  };

  async function create() {
    error = '';
    busy = 'Waiting for your wallet…';
    try {
      const d = draft!;
      result = await fundCampaign(
        {
          sender: account!, contractId: contract!, tokenId: token!, storageByteCost: config!.storage_byte_cost,
          costs: () => getStorageCosts(rpc!, contract!, token!),
          freePrepay: () => getPrepayBalance(rpc!, contract!, account!),
          send: (txs) => wallet!.send(txs),
          outcome: (hash) => ((busy = 'Waiting for the transaction…'), txOutcome(rpc!, hash, account!)),
        },
        { merkleRoot: d.merkleRoot, deadlineNs: (BigInt(deadlineMs) * 1_000_000n).toString(), leafCount: d.recipients.length, total: d.total },
      );
      publishTodo = (await downloadPublisher(env.PUBLIC_LEAVES_URL).publish(leafList(result.campaignId, d))).todo;
    } catch (e) {
      const msg = (e as Error).message;
      error = ERRORS[msg] ?? `The campaign was not created (${msg}). If tokens left your wallet, the contract refunded them.`;
    } finally {
      busy = '';
    }
  }

  async function copyAll() {
    await navigator.clipboard.writeText(links.join('\n'));
    copied = true;
  }
</script>

<h1>Send tokens to emails</h1>
<p class="muted">Each recipient claims with their Google account. The chain never sees an email.</p>

{#if setupError}
  <p class="error" role="alert">{setupError}</p>
{:else if result && draft}
  <h2>Campaign {result.campaignId} is live</h2>
  {#if env.PUBLIC_EXPLORER_TX_URL}
    <p><a href="{env.PUBLIC_EXPLORER_TX_URL}{result.txHash}" target="_blank" rel="noopener noreferrer">View the transaction</a></p>
  {/if}
  {#if publishTodo}<p><strong>One more step:</strong> {publishTodo}</p>{/if}

  <h2>Claim links</h2>
  <p class="error">
    These links are the only copy of each recipient's salt. Send each link only to its recipient and keep them
    private: anyone holding a link can test whether it matches an email they guess. Without the links (or your
    recovery file) nobody can claim, and you can only reclaim after the deadline.
  </p>
  <textarea readonly rows="8" aria-label="Claim links">{links.join('\n')}</textarea>
  <p>
    <button onclick={copyAll}>{copied ? 'Copied' : 'Copy all'}</button>
    <button onclick={() => saveFile(`zarf-links-${result!.campaignId}.csv`, `email,amount,link\n${links.join('\n')}\n`, 'text/csv')}>Download as CSV</button>
  </p>
{:else}
  <h2>1. Recipients</h2>
  <p class="muted">One per line: <code>email,amount</code> in USDC. Use the exact address the recipient signs in to Google with.</p>
  <textarea bind:value={csv} rows="8" placeholder={'email,amount\nalice@example.com,10\nbob@example.com,2.5'} aria-label="Recipients CSV" disabled={!!draft}></textarea>
  {#if parsed.rows.length}
    <p>{parsed.rows.length} recipients, {formatAmount(parsed.total)} USDC in total.</p>
  {/if}
  {#if parsed.rejected.length}
    <div class="error" role="alert">
      <p>Fix these lines first:</p>
      <ul>
        {#each parsed.rejected as r (r.line)}<li>Line {r.line}: {r.reason}</li>{/each}
      </ul>
    </div>
  {/if}

  <h2>2. Deadline</h2>
  <input type="datetime-local" bind:value={deadline} aria-label="Claim deadline" disabled={!!draft} />
  {#if minMs !== null && deadline && !deadlineOk}
    <p class="error">The deadline must be after {new Date(minMs).toLocaleString()}.</p>
  {/if}
  <p class="muted">Recipients can claim until then. After it, you can reclaim whatever is left.</p>

  <h2>3. Wallet</h2>
  {#if account}
    <p>Sending from <code>{account}</code> <button onclick={disconnect} disabled={!!busy}>Disconnect</button></p>
  {:else}
    <button onclick={connect} disabled={!config}>Connect MyNearWallet</button>
  {/if}

  <h2>4. Create</h2>
  {#if !draft}
    <button class="primary" disabled={!ready} onclick={prepare}>Generate claim links</button>
  {:else}
    <p>Save the recovery file before you send anything. It holds every salt, so you can rebuild the links if this page is lost.</p>
    <p><button onclick={saveRecovery}>Download recovery file</button></p>
    <label><input type="checkbox" bind:checked={recoveryAck} disabled={!recoverySaved} /> I stored the recovery file somewhere private</label>
    <p>You send {formatAmount(BigInt(draft.total))} USDC to {draft.recipients.length} recipients, plus a small NEAR storage pre-pay that your wallet shows before you sign.</p>
    <button class="primary" disabled={!recoveryAck || !!busy} onclick={create}>{busy || 'Create campaign'}</button>
    <p><button onclick={() => (draft = null)} disabled={!!busy}>Edit recipients</button></p>
  {/if}
{/if}

{#if error}<p class="error" role="alert">{error}</p>{/if}

<style>
  textarea {
    width: 100%;
    box-sizing: border-box;
    font: 14px/1.4 ui-monospace, monospace;
    padding: 0.75rem;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: inherit;
  }
  h2 {
    font-size: 1.1rem;
    margin: 1.5rem 0 0.5rem;
  }
</style>
