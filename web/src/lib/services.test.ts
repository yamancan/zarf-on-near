import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../../spec/vectors.json';
import { accountExists, canRetry, ClaimError, describeCheckError, describeError, errorCode, failureHeading, isUnmapped, getCampaign, getClaimState, outcomeAfterRelay, relayAndSettle, relayAnswerLost, requestSignature, settleClaim, submitClaim, type ClaimState } from './services';

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
    expect(describeError(new ClaimError('E999'))).toBe('Something went wrong. Open your claim link and try again.');
    expect(errorCode(new ClaimError('E999'))).toBe('E999');
    expect(isUnmapped(new ClaimError('E999'))).toBe(true);
    expect(isUnmapped(new ClaimError('COMMITMENT_MISMATCH'))).toBe(false);
  });
  it.each([
    ['DESTINATION_CREDITS_NOBODY', 'That account cannot receive USDC this way. Use your own NEAR account.'],
    ['EMAIL_NOT_GOOGLE_AUTHORITATIVE', 'This address cannot prove itself with Google. Ask the sender to use your Gmail or work Google address.'],
    ['INTENTS_QUOTE_UNSIGNED', 'The exchange quote could not be checked. Try again or take it on NEAR.'],
    ['INTENTS_BAD_SIGNATURE', 'The exchange quote could not be checked. Try again or take it on NEAR.'],
  ])('T-006 server code %s gets its own line', (code, line) => {
    expect(describeError(new ClaimError(code))).toBe(line);
    expect(isUnmapped(new ClaimError(code))).toBe(false);
  });
  it('never puts a machine code in the sentence (critic P1-7)', () => {
    for (const c of ['HTTP_503', 'RPC_ERROR', 'E114_CLAIM_EXPIRED', 'RELAYER_NO_TX', 'BAD_AUDIENCE', 'INTENTS_WRONG_RECIPIENT', 'UNKNOWN_KID']) {
      expect(describeError(new ClaimError(c))).not.toMatch(/[A-Z]{2,}_[A-Z0-9]/);
    }
    expect(describeError(new ClaimError('HTTP_503'))).toMatch(/not answering/);
    expect(describeError(new ClaimError('E114_CLAIM_EXPIRED'))).toMatch(/took too long/);
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
      expect(describeCheckError(e)).toBe('NEAR is not answering right now.');
    }
  });
  it('keeps the set-up message for missing config', () => {
    expect(describeCheckError(new ClaimError('NOT_CONFIGURED:PUBLIC_NEAR_RPC_URL'))).toMatch(/not fully set up/);
  });
});

describe('failureHeading (receipt title agrees with its sentence, critic r3 M6)', () => {
  it('maps already claimed and already being paid; everything else is Not Claimed', () => {
    expect(failureHeading('E105_ALREADY_CLAIMED')).toEqual({ title: 'Already Claimed', muted: true });
    expect(failureHeading('E123_CLAIM_PENDING')).toEqual({ title: 'Already Being Paid', muted: true });
    for (const c of ['RPC_ERROR', 'E125_CAMPAIGN_ENDED', 'UNEXPECTED', '']) expect(failureHeading(c)).toEqual({ title: 'Not Claimed', muted: false });
  });
});

describe('pinned sentences (security review: removal mutants survived)', () => {
  it('E123, E105 and the INTENTS_ fallback say exactly this', () => {
    expect(describeError(new ClaimError('E123_CLAIM_PENDING'))).toBe('This claim is already being paid. Check back in a minute.');
    expect(describeError(new ClaimError('E105_ALREADY_CLAIMED'))).toBe('This link was already claimed.');
    expect(describeError(new ClaimError('INTENTS_SOMETHING_NEW'))).toBe("The cross-chain quote doesn't match what you chose. Open your claim link to get a new one.");
    expect(describeError(new ClaimError('INTENTS_NOT_PENDING'))).toBe('This cross-chain quote was already used. Open your claim link to get a new one.');
    expect(isUnmapped(new ClaimError('INTENTS_SOMETHING_NEW'))).toBe(true);
  });
});

describe('relayAndSettle (receipt: the relayer was called)', () => {
  const clock = (step = 100) => { let t = 0; return () => (t += step); };
  const o = (step = 100) => ({ timeoutMs: 60_000, graceMs: 0, sleep: async () => {}, now: clock(step) });
  const states = (...xs: ClaimState[]) => { let i = 0; return async () => xs[Math.min(i++, xs.length - 1)]; };
  const lost = [new TypeError('Failed to fetch'), new ClaimError('HTTP_502'), new ClaimError('UPSTREAM_UNAVAILABLE'), new ClaimError('RELAYER_NO_TX')];

  it('relayer answer lost after submit: the result follows claim_state, never Not claimed while the chain says pending or claimed', async () => {
    for (const e of lost) {
      expect(relayAnswerLost(e)).toBe(true);
      const fail = async () => { throw e; };
      expect(await relayAndSettle(fail, states('pending', 'claimed'), o())).toEqual({ state: 'claimed', txHash: '' });
      expect(await relayAndSettle(fail, states('pending'), o(30_000))).toEqual({ state: 'pending', txHash: '' });
      // Nothing landed: the original error comes back, so the page offers a retry.
      await expect(relayAndSettle(fail, states('unclaimed'), o())).rejects.toBe(e);
    }
  });
  it('a refusal is not lost: thrown at once, the chain is not read', async () => {
    const read = vi.fn(states('claimed'));
    for (const code of ['E115_TOKEN_TRANSFER_FAILED', 'E105_ALREADY_CLAIMED', 'RATE_LIMITED', 'E101_INVALID_SIGNATURE', 'HTTP_404']) {
      const e = new ClaimError(code);
      expect(relayAnswerLost(e)).toBe(false);
      await expect(relayAndSettle(async () => { throw e; }, read, o())).rejects.toBe(e);
    }
    expect(read).not.toHaveBeenCalled();
  });
  it('an answer that arrived keeps its hash: paid at once, or a 202 settled from the chain', async () => {
    expect(await relayAndSettle(async () => ({ txHash: 'H', paid: true }), states('unclaimed'), o())).toEqual({ state: 'claimed', txHash: 'H' });
    expect(await relayAndSettle(async () => ({ txHash: 'H', paid: false }), states('pending', 'claimed'), o())).toEqual({ state: 'claimed', txHash: 'H' });
  });
});

describe('copy for the second audit S1 codes', () => {
  it.each([
    ['E128_INSUFFICIENT_STORAGE', /storage reserve.*top it up.*fund_campaign_storage/],
    ['DESTINATION_IS_CONTRACT', /Zarf contract itself/],
    ['DESTINATION_IS_TOKEN', /USDC token contract/],
  ])('%s has its own sentence', (code, re) => expect(describeError(new ClaimError(code))).toMatch(re));
});
