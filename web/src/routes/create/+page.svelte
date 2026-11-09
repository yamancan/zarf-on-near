<script lang="ts">
  import { onMount } from 'svelte';
  import { env } from '$env/dynamic/public';
  import { buildDraft, claimLink, leafList, recoveryFile, type Draft } from '$lib/create/campaign';
  import { getCampaignByRoot, getCampaignView, getConfig, getPrepayBalance, getStorageCosts, txOutcome, type ContractConfig } from '$lib/create/chain';
  import {
    checkCreation, fundCampaign, LookupPending, mayCreate, minDeadlineMs, NotCreated, NotSent, OutcomeUnclear, readMarker, resolveByRoot,
    settleAfterUncertain, type UnresolvedMarker,
  } from '$lib/create/funding';
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
  let walletReady = $state(false); // the wallet module loads after the config; Connect waits for it
  let account = $state<string | null>(null);
  let draft = $state<Draft | null>(null);
  let recoverySaved = $state(false);
  let recoveryAck = $state(false);
  let busy = $state('');
  let error = $state('');
  let result = $state<{ campaignId: string; txHash: string } | null>(null);
  let publishTodo = $state<string | null>(null);
  let copied = $state(false);
  // A funding tx that was sent: while set, Create stays off until its outcome is known.
  let sentTx = $state<string | null>(null);
  let txState = $state<'checking' | 'settling' | 'unclear' | 'mismatch' | null>(null);
  // Once a send may have gone out, this draft (its merkle_root) is pinned: re-sending the same root is
  // safe (E132 refunds a duplicate), a new draft is not. Unpinned only by a campaign or a proven refund.
  let pinned = $state(false);
  let hadUncertain = false;
  // Other tabs: an unresolved send there means a new draft here could fund twice.
  const MARKER_KEY = 'zarf-near:unresolved';
  let otherTab = $state<UnresolvedMarker | null>(null);
  let otherTabNote = $state('');
  const setMarker = (m: UnresolvedMarker | null) => {
    try {
      if (m) localStorage.setItem(MARKER_KEY, JSON.stringify(m));
      else localStorage.removeItem(MARKER_KEY);
    } catch {
      // best effort: this tab's own pin still holds
    }
  };
  let sentFrom = $state<string | null>(null); // the sender of sentTx (the tx lookup needs it)
  /** Pinned to a sender: only that account may send this draft (a second account would fund it twice). */
  const sendable = $derived(mayCreate({ pinned, sentFrom, account }));
  // Display only (Create itself goes through mayCreate): pinned to someone else, or to nobody connected.
  const wrongAccount = $derived(pinned && !!sentFrom && account !== sentFrom);

  const FUNDING_KEY = 'zarf-near:create-funding';
  interface Funding {
    txHash: string | null; // null: the wallet was asked but no hash came back (yet)
    sender: string;
    draft: Draft;
    deadline: string;
    campaignId?: string;
    uncertain?: boolean; // a send whose outcome was lost happened for this draft
  }
  /** True if persisted. Before a send it must succeed (see beforeSend); later writes are best effort. */
  const saveFunding = (f: Funding): boolean => {
    try {
      sessionStorage.setItem(FUNDING_KEY, JSON.stringify(f));
      return true;
    } catch {
      return false;
    }
  };
  const loadFunding = (): Funding | null => {
    try {
      return JSON.parse(sessionStorage.getItem(FUNDING_KEY) ?? 'null');
    } catch {
      return null;
    }
  };
  const clearFunding = () => {
    try {
      sessionStorage.removeItem(FUNDING_KEY);
    } catch {
      // nothing to clear
    }
  };

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
      walletReady = true;
      account = wallet.accountId();
      // A funding tx from before a reload: resume checking it instead of offering Create again.
      const f = loadFunding();
      if (!f) {
        try {
          otherTab = readMarker(localStorage, MARKER_KEY, Date.now());
        } catch {
          otherTab = null;
        }
      }
      if (f) {
        draft = f.draft;
        deadline = f.deadline;
        recoverySaved = recoveryAck = true;
        sentFrom = f.sender;
        pinned = true;
        hadUncertain = !!f.uncertain;
        if (f.campaignId) result = { campaignId: f.campaignId, txHash: f.txHash ?? '' };
        else if (f.txHash) await check(f.txHash);
        else await checkByRoot(); // reloaded while the wallet popup was open
      }
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
    const ctx = { contractId: contract!, network: config!.network, claimOrigin };
    saveFile(`zarf-recovery-${draft!.merkleRoot.slice(0, 8)}.json`, recoveryFile(draft!, (BigInt(deadlineMs) * 1_000_000n).toString(), ctx));
    recoverySaved = true;
  }

  const ERRORS: Record<string, string> = {
    E119_INVALID_DEADLINE: 'The deadline is too early for this contract. Pick a later one.',
    E126_UNKNOWN_TOKEN: 'The contract does not accept this token.',
    E127_NO_VERIFIER: 'The contract has no verifier key that covers this deadline.',
    E128_INSUFFICIENT_STORAGE: 'The storage pre-pay was too low twice in a row. Your tokens were refunded; try again.',
  };

  const lookup = { outcome: (hash: string) => txOutcome(rpc!, hash, sentFrom ?? account!), contractId: contract!, tokenId: token! };

  async function created(r: { campaignId: string; txHash: string }) {
    result = r;
    txState = null;
    setMarker(null);
    saveFunding({ txHash: r.txHash, sender: sentFrom ?? account!, draft: draft!, deadline, campaignId: r.campaignId });
    publishTodo = (await downloadPublisher(env.PUBLIC_LEAVES_URL).publish(leafList(r.campaignId, draft!))).todo;
  }

  const byRoot = () => ({
    sender: sentFrom ?? account!,
    campaignByRoot: (sender: string, root: string) => getCampaignByRoot(rpc!, contract!, sender, root),
    campaign: (id: string) => getCampaignView(rpc!, contract!, id),
  });

  /**
   * The wallet failed or the page reloaded before a hash came back: the tx may have landed anyway.
   * The draft's merkle_root is an idempotency key, so ask the contract. Never assume nothing was sent.
   */
  async function checkByRoot() {
    txState = 'checking';
    busy = 'Checking whether the campaign exists…';
    try {
      const id = await resolveByRoot(byRoot(), { merkleRoot: draft!.merkleRoot, total: draft!.total });
      if (id) {
        await created({ campaignId: id, txHash: sentTx ?? '' });
      } else {
        // Not landed (yet). Keep the draft pinned: only the same root may be sent again.
        sentTx = txState = null;
        error =
          'Your wallet did not confirm, and no campaign exists for these links yet. You can send the same campaign ' +
          'again: if the earlier transaction still lands, the contract refunds the duplicate. These links stay as they are.';
      }
    } catch (e) {
      // A campaign under our (sender, root) that does not match is terminal; an unreadable contract is not.
      txState = (e as Error).message === 'CAMPAIGN_MISMATCH' ? 'mismatch' : 'checking';
    } finally {
      busy = '';
    }
  }

  const recheck = () => (sentTx ? check(sentTx) : checkByRoot());

  function failed(e: unknown) {
    if (e instanceof LookupPending) {
      txState = 'checking'; // sent, outcome unknown: Create stays off
    } else if (e instanceof OutcomeUnclear) {
      txState = 'unclear';
    } else if (e instanceof NotSent) {
      error = 'This browser would not store the campaign before sending, so nothing was sent. Allow site storage and try again.';
    } else if (e instanceof NotCreated) {
      // Proven for this tx: the tokens are back (or never left).
      const msg = ERRORS[e.code] ?? `The campaign was not created (${e.code}). Your tokens were returned.`;
      if (hadUncertain) void unpinAfterSecondLook(msg);
      else unpin(msg);
    } else if (sentTx) {
      txState = 'checking';
    } else {
      // SendUncertain or any other failure without a hash: remember it, then ask the contract.
      hadUncertain = true;
      if (draft && sentFrom) saveFunding({ txHash: null, sender: sentFrom, draft, deadline, uncertain: true });
      void checkByRoot();
    }
  }

  function unpin(msg: string) {
    sentTx = txState = null;
    pinned = hadUncertain = false;
    clearFunding();
    setMarker(null);
    error = msg;
  }

  /** An earlier send's outcome was lost, so it may still land: look by root once more before unpinning. */
  async function unpinAfterSecondLook(msg: string) {
    txState = 'settling'; // its own state: create()'s finally clears `busy` while this runs
    try {
      const id = await settleAfterUncertain(byRoot(), { merkleRoot: draft!.merkleRoot, total: draft!.total });
      if (id) await created({ campaignId: id, txHash: sentTx ?? '' });
      else unpin(msg);
    } catch (e) {
      txState = (e as Error).message === 'CAMPAIGN_MISMATCH' ? 'mismatch' : 'checking';
    }
  }

  /** Looks up a funding tx that was already sent. Never sends anything. */
  async function check(txHash: string) {
    sentTx = txHash;
    txState = 'checking';
    busy = 'Checking the transaction…';
    try {
      const c = await checkCreation(lookup, txHash, { merkleRoot: draft!.merkleRoot, total: draft!.total });
      if (c.kind === 'created') await created(c);
      else if (c.kind === 'refunded') failed(new NotCreated(c.code, txHash));
      else txState = 'unclear';
    } catch (e) {
      failed(e);
    } finally {
      busy = '';
    }
  }

  async function create() {
    error = '';
    if (!sendable.ok) {
      error = sendable.reason;
      return;
    }
    busy = 'Waiting for your wallet…';
    try {
      const d = draft!;
      await created(
        await fundCampaign(
          {
            sender: account!, contractId: contract!, tokenId: token!, storageByteCost: config!.storage_byte_cost,
            costs: () => getStorageCosts(rpc!, contract!, token!),
            freePrepay: () => getPrepayBalance(rpc!, contract!, account!),
            send: (txs) => wallet!.send(txs),
            campaignByRoot: byRoot().campaignByRoot,
            campaign: byRoot().campaign,
            beforeSend: () => {
              if (!saveFunding({ txHash: null, sender: account!, draft: d, deadline, uncertain: hadUncertain })) throw new Error('session storage unavailable');
              sentFrom = account;
              pinned = true;
              setMarker({ root: d.merkleRoot, sender: account!, total: d.total, at: Date.now() });
            },
            onSent: (txHash) => {
              sentTx = txHash;
              sentFrom = account;
              busy = 'Checking the transaction…';
              saveFunding({ txHash, sender: account!, draft: d, deadline });
            },
            outcome: lookup.outcome,
          },
          { merkleRoot: d.merkleRoot, deadlineNs: (BigInt(deadlineMs) * 1_000_000n).toString(), leafCount: d.recipients.length, total: d.total },
        ),
      );
    } catch (e) {
      failed(e);
    } finally {
      busy = '';
    }
  }

  /** "Check it" for another tab's unresolved send: clear the marker once its (sender, root) has a campaign. */
  async function checkOtherTab() {
    const m = otherTab!;
    otherTabNote = 'Checking…';
    try {
      const id = await resolveByRoot(
        { sender: m.sender, campaignByRoot: (s, r) => getCampaignByRoot(rpc!, contract!, s, r), campaign: (i) => getCampaignView(rpc!, contract!, i) },
        { merkleRoot: m.root, total: m.total },
      );
      if (id) {
        setMarker(null);
        otherTab = null;
        otherTabNote = `That campaign was created (campaign ${id}). You can start a new one here.`;
      } else {
        otherTabNote = 'It has not been created yet. Finish it in its tab, or wait and check again.';
      }
    } catch {
      otherTabNote = 'Could not check right now. Try again in a minute.';
    }
  }

  /** After a finished (or mismatched) campaign: forget it in this tab and begin a new draft. */
  function startOver() {
    clearFunding();
    setMarker(null);
    draft = result = null;
    sentTx = sentFrom = txState = publishTodo = null;
    pinned = recoverySaved = recoveryAck = copied = false;
    csv = error = '';
  }

  async function copyAll() {
    await navigator.clipboard.writeText(links.join('\n'));
    copied = true;
  }
</script>

<h1>Send tokens to emails</h1>
<p class="muted">
  Each recipient claims with their Google account. Emails never go on chain; when someone claims, our verifier sees
  their email to check it matches the claim.
</p>

{#if otherTab && !draft}
  <p class="error" role="alert">
    Another tab has a campaign from <code>{otherTab.sender}</code> whose send has not resolved yet. Finish it there
    before creating a new one here, or the same tokens could be sent twice.
  </p>
  <p><button onclick={checkOtherTab} disabled={!config}>Check it</button></p>
{/if}
{#if otherTabNote}<p role="status">{otherTabNote}</p>{/if}

{#if setupError}
  <p class="error" role="alert">{setupError}</p>
{:else if result && draft}
  <h2>Campaign {result.campaignId} is live</h2>
  {#if env.PUBLIC_EXPLORER_TX_URL && result.txHash}
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
  <p>
    <button onclick={startOver}>Start a new campaign</button>
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
  {#if pinned && !wrongAccount}
    <p>Sending from <code>{account}</code>. This campaign is tied to this account until it resolves.</p>
  {:else}
    {#if wrongAccount}
      <p class="error" role="alert">This draft belongs to <code>{sentFrom}</code>: reconnect {sentFrom} to continue.</p>
    {/if}
    {#if account}
      <p>Sending from <code>{account}</code> <button onclick={disconnect} disabled={!!busy}>Disconnect</button></p>
    {:else}
      <button onclick={connect} disabled={!walletReady}>Connect MyNearWallet</button>
    {/if}
  {/if}

  <h2>4. Create</h2>
  {#if !draft}
    <button class="primary" disabled={!ready} onclick={prepare}>Generate claim links</button>
  {:else}
    <p>Save the recovery file before you send anything. It holds every salt, so you can rebuild the links if this page is lost.</p>
    <p><button onclick={saveRecovery}>Download recovery file</button></p>
    <label><input type="checkbox" bind:checked={recoveryAck} disabled={!recoverySaved} /> I stored the recovery file somewhere private</label>
    <p>You send {formatAmount(BigInt(draft.total))} USDC to {draft.recipients.length} recipients, plus a small NEAR storage pre-pay that your wallet shows before you sign.</p>
    {#if txState === 'checking'}
      <p role="status">Checking whether your campaign was created… Do not send again until this finishes.</p>
      <p>
        <button onclick={recheck} disabled={!!busy}>{busy || 'Check again'}</button>
        {#if env.PUBLIC_EXPLORER_TX_URL && sentTx}<a href="{env.PUBLIC_EXPLORER_TX_URL}{sentTx}" target="_blank" rel="noopener noreferrer">View it on the explorer</a>{/if}
      </p>
    {:else if txState === 'settling'}
      <p role="status">
        That attempt was refunded. Making sure an earlier attempt did not land (about 90 seconds) before these links can change…
      </p>
    {:else if txState === 'mismatch'}
      <p class="error" role="alert">
        The contract holds a campaign for these links that does not match this draft. It is not used. Generate new links.
      </p>
      <p><button onclick={startOver}>Generate new links</button></p>
    {:else if txState === 'unclear'}
      <p class="error" role="alert">
        The transaction ran but did not create this campaign, and we could not confirm your tokens came back. Do not
        send again; check it on the explorer first.
      </p>
      {#if env.PUBLIC_EXPLORER_TX_URL && sentTx}<p><a href="{env.PUBLIC_EXPLORER_TX_URL}{sentTx}" target="_blank" rel="noopener noreferrer">View it on the explorer</a></p>{/if}
    {:else}
      <button class="primary" disabled={!recoveryAck || !!busy || !!sentTx || !sendable.ok} onclick={create}>{busy || 'Create campaign'}</button>
      {#if !pinned}<p><button onclick={() => (draft = null)} disabled={!!busy}>Edit recipients</button></p>{/if}
    {/if}
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
