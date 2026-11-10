import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../../spec/vectors.json';
import { accountExists, canRetry, ClaimError, describeCheckError, describeError, getCampaign, getClaimState, outcomeAfterRelay, requestSignature, settleClaim, submitClaim, type ClaimState } from './services';

const reply = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
afterEach(() => vi.unstubAllGlobals());
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof ClaimError ? e.code : String(e)));

describe('getCampaign (NEAR RPC view)', () => {
  it('sends a call_function query and decodes the byte result', async () => {
    const campaign = { merkle_root: vectors.campaigns.main.merkle_root, deadline_ns: vectors.context.deadline_ns };
    const fetchMock = reply({ jsonrpc: '2.0', result: { result: [...new TextEncoder().encode(JSON.stringify(campaign))] } });
    vi.stubGlobal('fetch', fetchMock);
    expect(await getCampaign('https://rpc.test', 'zarf-near.testnet', '7')).toEqual(campaign);
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.params).toMatchObject({ request_type: 'call_function', account_id: 'zarf-near.testnet', method_name: 'get_campaign' });
    expect(JSON.parse(atob(sent.params.args_base64))).toEqual({ campaign_id: '7' });
  });
  it('fails on an RPC error', async () => {
    vi.stubGlobal('fetch', reply({ error: { name: 'HANDLER_ERROR' } }));
    expect(await code(getCampaign('https://rpc.test', 'c', '7'))).toBe('RPC_ERROR');
  });
  it('says what is not configured', async () => {
    expect(await code(getCampaign('', 'c', '7'))).toBe('NOT_CONFIGURED:PUBLIC_NEAR_RPC_URL');
    expect(await code(getCampaign('https://rpc.test', undefined, '7'))).toBe('NOT_CONFIGURED:PUBLIC_CONTRACT_ID');
  });
});

describe('verifier and relayer', () => {
  it('passes the verifier error code through', async () => {
    vi.stubGlobal('fetch', reply({ error: 'COMMITMENT_MISMATCH' }, 403));
    const err = await requestSignature('https://v.test', {}).catch((e) => e);
    expect(err).toBeInstanceOf(ClaimError);
    expect(describeError(err)).toMatch(/different Google account/);
  });
  const HASH = '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm';
  it('posts the signed args to the relayer and returns the tx hash', async () => {
    const fetchMock = reply({ tx_hash: HASH, status: 'paid' });
    vi.stubGlobal('fetch', fetchMock);
    const args = vectors.claims.valid[0].call_args;
    expect(await submitClaim('https://r.test', args)).toEqual({ txHash: HASH, paid: true });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://r.test/claim');
  });
  it('a 202 "submitted" from the relayer still yields the hash, so the receipt polls claim_state', async () => {
    vi.stubGlobal('fetch', reply({ tx_hash: HASH, status: 'submitted' }, 202));
    expect(await submitClaim('https://r.test', vectors.claims.valid[0].call_args)).toEqual({ txHash: HASH, paid: false });
  });
  it('a 409 E115 from the relayer is the reopened-claim error', async () => {
    vi.stubGlobal('fetch', reply({ error: 'E115_TOKEN_TRANSFER_FAILED', tx_hash: HASH }, 409));
    const err = await submitClaim('https://r.test', vectors.claims.valid[0].call_args).catch((e) => e);
    expect(describeError(err)).toMatch(/open again/);
  });
  it.each([[{}], [{ tx_hash: 'H' }], [{ tx_hash: `${HASH}"><script>` }], [{ tx_hash: 'O0Il'.repeat(11) }]])('refuses relayer reply %j', async (body) => {
    vi.stubGlobal('fetch', reply(body));
    expect(await code(submitClaim('https://r.test', vectors.claims.valid[0].call_args))).toBe('RELAYER_NO_TX');
  });
  it.each(['UPSTREAM_UNAVAILABLE', 'E101_INVALID_SIGNATURE', 'E129_INSUFFICIENT_BALANCE', 'BAD_DESTINATION', 'LINK_MISMATCH'])('has copy for %s', (c) => {
    expect(describeError(new ClaimError(c))).not.toMatch(/did not go through/);
  });
  it('explains missing config and unknown codes', () => {
    expect(describeError(new ClaimError('NOT_CONFIGURED:PUBLIC_VERIFIER_URL'))).toMatch(/PUBLIC_VERIFIER_URL/);
    expect(describeError(new ClaimError('E999'))).toMatch(/E999/);
  });
});

describe('settleClaim (after the relayer returns a hash)', () => {
  // A fake clock: sleep advances time instead of waiting.
  const clock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms), elapsed: () => t };
  };
  const reads = (...states: (ClaimState | Error)[]) => {
    let i = 0;
    return async () => {
      const s = states[Math.min(i++, states.length - 1)];
      if (s instanceof Error) throw s;
      return s;
    };
  };

  it('claimed: returns as soon as the chain says so', async () => {
    const c = clock();
    expect(await settleClaim(reads('pending', 'pending', 'claimed'), c)).toBe('claimed');
    expect(c.elapsed()).toBe(3000); // 1 s + 2 s backoff
  });
  it('unclaimed after pending: the transfer failed and the claim reopened', async () => {
    expect(await settleClaim(reads('pending', 'unclaimed'), clock())).toBe('unclaimed');
  });
  it('a lagging node that still says unclaimed is not believed within the grace period', async () => {
    const c = clock();
    expect(await settleClaim(reads('unclaimed', 'unclaimed', 'pending', 'claimed'), c)).toBe('claimed');
  });
  it('unclaimed with no pending ever seen becomes final after the 20 s grace', async () => {
    const c = clock();
    expect(await settleClaim(reads('unclaimed'), c)).toBe('unclaimed');
    expect(c.elapsed()).toBeGreaterThanOrEqual(19_000);
  });
  it('still pending after ~60 s: gives up without claiming success or failure', async () => {
    const c = clock();
    expect(await settleClaim(reads('pending'), c)).toBe('pending');
    expect(c.elapsed()).toBeLessThanOrEqual(60_000);
    expect(c.elapsed()).toBeGreaterThan(50_000);
  });
  it('treats an unexpected value as still pending', async () => {
    expect(await settleClaim(reads('weird' as ClaimState, 'unclaimed'), clock())).toBe('unclaimed');
  });
  it('treats a failed read as still pending', async () => {
    expect(await settleClaim(reads(new Error('rpc'), 'claimed'), clock())).toBe('claimed');
    expect(await settleClaim(reads(new Error('rpc')), clock())).toBe('pending');
  });
  it('a relayer "paid" (claim_paid event) is claimed at once, even if a lagging node says unclaimed', async () => {
    const read = vi.fn(reads('unclaimed'));
    expect(await outcomeAfterRelay({ paid: true }, read, clock())).toBe('claimed');
    expect(read).not.toHaveBeenCalled();
  });
  it('a relayer 202 polls: pending -> claimed', async () => {
    expect(await outcomeAfterRelay({ paid: false }, reads('pending', 'claimed'), clock())).toBe('claimed');
  });
  it('reads claim_state from the contract at optimistic finality', async () => {
    const fetchMock = reply({ result: { result: [...new TextEncoder().encode('"claimed"')] } });
    vi.stubGlobal('fetch', fetchMock);
    expect(await getClaimState('https://rpc.test', 'zarf-near.testnet', '7', 'ab'.repeat(32))).toBe('claimed');
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.params.method_name).toBe('claim_state');
    expect(sent.params.finality).toBe('optimistic');
    expect(JSON.parse(atob(sent.params.args_base64))).toEqual({ campaign_id: '7', commitment: 'ab'.repeat(32) });
  });
});

describe('canRetry (no "try again" when it cannot help)', () => {
  it.each(['E105_ALREADY_CLAIMED', 'E125_CAMPAIGN_ENDED', 'E110_UNKNOWN_CAMPAIGN'])('%s: no retry hint', (c) => {
    expect(canRetry(new ClaimError(c))).toBe(false);
  });
  it.each(['UPSTREAM_UNAVAILABLE', 'EXPIRED', 'BAD_NONCE', 'E115_TOKEN_TRANSFER_FAILED', 'RATE_LIMITED'])('%s: retry hint', (c) => {
    expect(canRetry(new ClaimError(c))).toBe(true);
  });
  it('an unexpected error keeps the hint', () => expect(canRetry(new Error('x'))).toBe(true));
});

describe('accountExists (view_account)', () => {
  it('true when the account exists', async () => {
    const f = reply({ jsonrpc: '2.0', result: { amount: '1' } });
    vi.stubGlobal('fetch', f);
    expect(await accountExists('https://rpc.test', 'alice.testnet')).toBe(true);
    const sent = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.params).toEqual({ request_type: 'view_account', finality: 'final', account_id: 'alice.testnet' });
  });
  it('false only on UNKNOWN_ACCOUNT', async () => {
    vi.stubGlobal('fetch', reply({ jsonrpc: '2.0', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' } } }));
    expect(await accountExists('https://rpc.test', 'nobody.testnet')).toBe(false);
  });
  it('throws on any other failure, so the page never says "not found" for an outage', async () => {
    vi.stubGlobal('fetch', reply({ jsonrpc: '2.0', error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' } } }));
    expect(await code(accountExists('https://rpc.test', 'alice.testnet'))).toBe('RPC_ERROR');
    vi.stubGlobal('fetch', reply({}, 503));
    expect(await code(accountExists('https://rpc.test', 'alice.testnet'))).toBe('HTTP_503');
  });
});

describe('describeCheckError (claim page, before any claim)', () => {
  it('a network or RPC failure says the page could not check, not that a claim failed', () => {
    for (const e of [new ClaimError('HTTP_503'), new ClaimError('RPC_ERROR'), new TypeError('Failed to fetch')]) {
      expect(describeCheckError(e)).toBe('We could not check this claim link on NEAR right now. Nothing was claimed.');
    }
  });
  it('keeps the set-up message for missing config', () => {
    expect(describeCheckError(new ClaimError('NOT_CONFIGURED:PUBLIC_NEAR_RPC_URL'))).toMatch(/not fully set up/);
  });
});
