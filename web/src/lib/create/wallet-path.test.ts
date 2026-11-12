// T-014: one test per finding of the T-012 sender-wallet review.
import { describe, expect, it, vi } from 'vitest';
import {
  AccountChanged, CHECKING_TX, fundCampaign, readSentOutcome, releaseAfterReject, sendHooks, SendUncertain, WAITING_FOR_WALLET,
  walletWaitNote, type FundDeps, type Outcome, type SendRecord, type Tx,
} from './funding';
import { assertSigner } from './wallet';

const CONTRACT = 'zarf-near-1112.testnet';
const TOKEN = 'usdc.testnet';
const SENDER = 'alice.testnet';
const p = { merkleRoot: 'ab'.repeat(32), deadlineNs: '1800000000000000000', leafCount: 1, total: '100000' };
const costs = { ft_storage_deposit: '0', claim_entry_cost: '0', per_claim_storage: '2310000000000000000000', campaign_bytes_cost: '7090000000000000000000' };
const e128: Outcome = { receipts_outcome: [{ outcome: { executor_id: CONTRACT, status: { Failure: { ActionError: 'E128_INSUFFICIENT_STORAGE' } } } }] };

const deps = (over: Partial<FundDeps>): FundDeps => ({
  sender: SENDER, contractId: CONTRACT, tokenId: TOKEN, storageByteCost: '10000000000000000000',
  costs: async () => costs, freePrepay: async () => '0',
  send: async () => [], outcome: async () => ({}),
  campaignByRoot: async () => null, campaign: async () => null,
  lookupRetries: 0, sleep: async () => {},
  ...over,
});

/** The /create page's state, written only through sendHooks, as the page does. */
const pageModel = (uncertain = false) => {
  const st = { sentTx: null as string | null, busy: '', saved: [] as SendRecord[], pins: 0 };
  const hooks = sendHooks({
    set: (patch) => {
      if (patch.sentTx !== undefined) st.sentTx = patch.sentTx;
      if (patch.busy !== undefined) st.busy = patch.busy;
    },
    uncertain: () => uncertain,
    save: (r) => (st.saved.push(r), true),
    pin: () => void st.pins++,
  });
  return { st, hooks };
};

describe('finding 1: the E128 auto-retry starts clean', () => {
  it('drops the refunded first hash and shows the wallet line before asking the wallet again', async () => {
    const { st, hooks } = pageModel();
    const seenAtSend: { sentTx: string | null; busy: string }[] = [];
    let call = 0;
    const err = await fundCampaign(
      deps({
        ...hooks,
        send: async (txs) => {
          seenAtSend.push({ sentTx: st.sentTx, busy: st.busy });
          if (++call === 1) return txs.map((_, i) => `h1-${i}`);
          throw new Error('wallet closed after broadcasting'); // the second send's outcome is unknown
        },
        outcome: async () => e128, // the first send was refunded with E128: fundCampaign retries once
      }),
      p,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SendUncertain);
    expect(seenAtSend[1]).toEqual({ sentTx: null, busy: WAITING_FOR_WALLET });
    // So failed() takes the by-root path, never the refunded first tx (which would unpin "your USDC is back").
    expect(st.sentTx).toBeNull();
  });
});

describe('finding 7: onSent keeps the uncertain flag', () => {
  it('saves uncertain: true with the hash when an earlier send was uncertain', () => {
    const { st, hooks } = pageModel(true);
    hooks.beforeSend!();
    hooks.onSent!('h');
    expect(st.saved).toEqual([{ txHash: null, uncertain: true }, { txHash: 'h', uncertain: true }]);
    expect(st).toMatchObject({ sentTx: 'h', busy: CHECKING_TX });
  });
});

describe('finding 2: refuse to sign when the wallet holds another account', () => {
  const txs: Tx[] = [{ signerId: SENDER, receiverId: TOKEN, actions: [] }];
  it('throws ACCOUNT_CHANGED unless the wallet holds the signer', () => {
    expect(() => assertSigner([{ accountId: 'bob.testnet' }], txs)).toThrow(AccountChanged);
    expect(() => assertSigner([], txs)).toThrow(AccountChanged);
    expect(() => assertSigner([{ accountId: 'bob.testnet' }, { accountId: SENDER }], txs)).not.toThrow();
  });
  it('fundCampaign passes ACCOUNT_CHANGED through: nothing was signed, so it is not send-uncertain', async () => {
    const err = await fundCampaign(deps({ send: async (t) => (assertSigner([{ accountId: 'bob.testnet' }], t), []) }), p).catch((e) => e);
    expect(err).toBeInstanceOf(AccountChanged);
    expect((err as AccountChanged).expected).toBe(SENDER);
  });
});

describe('finding 3: a short list of hashes is not the funding tx', () => {
  it('a wallet that returned only the prepay hash goes the send-uncertain (by-root) way, never reads that hash', async () => {
    const outcome = vi.fn(async () => ({}));
    const err = await fundCampaign(deps({ send: async (txs) => (expect(txs).toHaveLength(2), ['prepay-hash']), outcome }), p).catch((e) => e);
    expect(err).toBeInstanceOf(SendUncertain);
    expect(outcome).not.toHaveBeenCalled();
  });
});

describe('finding 4: Change the list after a rejected wallet', () => {
  const expect_ = { merkleRoot: p.merkleRoot, total: p.total };
  it('frees the list when no campaign shows up after the wait', async () => {
    const sleep = vi.fn(async () => {});
    expect(await releaseAfterReject(deps({}), expect_, { sleep })).toEqual({ kind: 'free' });
    expect(sleep).toHaveBeenCalledWith(90_000);
  });
  it('adopts the campaign if the rejected-looking send landed after all', async () => {
    const d = deps({ campaignByRoot: async () => '7', campaign: async () => ({ merkle_root: p.merkleRoot, amount: p.total, sender: SENDER }) });
    expect(await releaseAfterReject(d, expect_, { sleep: async () => {} })).toEqual({ kind: 'created', campaignId: '7' });
  });
});

describe('finding 5: a wallet that never answers', () => {
  it('suggests a reload after 2 minutes in the wallet, not before', () => {
    expect(walletWaitNote(null, 10_000_000)).toBeNull();
    expect(walletWaitNote(0, 119_999)).toBeNull();
    expect(walletWaitNote(0, 120_000)).toBe('Closed the wallet? Reload; nothing is lost.');
  });
});

describe('finding 6: /campaigns reads a sent tx with retries', () => {
  it('returns null (sent, not read yet) when the lookup keeps failing, never "not sent"', async () => {
    const outcome = vi.fn(async () => { throw new Error('rpc down'); });
    expect(await readSentOutcome({ outcome, lookupRetries: 2, sleep: async () => {} }, 'h')).toBeNull();
    expect(outcome).toHaveBeenCalledTimes(3);
  });
  it('returns the outcome once a retry reads it', async () => {
    let n = 0;
    const o: Outcome = { receipts_outcome: [] };
    expect(await readSentOutcome({ outcome: async () => (++n < 2 ? Promise.reject(new Error('x')) : o), sleep: async () => {} }, 'h')).toBe(o);
  });
});
