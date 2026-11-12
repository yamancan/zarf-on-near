import { describe, expect, it } from 'vitest';
import live from './fixtures/oneclick-dry-exact-output.json';
import { NEAR_USDC_ASSET, QuoteError, type StatusView } from '../intents';
import { ed25519B58, quoteSignedBytes, verifyQuoteSignature } from '../oneclickSig';
import {
  CANNOT_CHECK, describeFunding, FUNDING_CHAINS, followFunding, fundingCapError, fundingRequest, fundingWithinLossBound,
  getFundingQuote, loadFunding, refundConfirmed, saveFunding, TOO_COSTLY, type FundingArgs,
} from './fundIn';

const base = FUNDING_CHAINS.find((c) => c.key === 'base')!;
const REFUND = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
// The live fixture: a dry EXACT_OUTPUT quote from 1Click mainnet (13 Nov 2026), 10 USDC from Base to `aurora`.
const liveArgs: FundingArgs = { chain: base, amount: '10000000', recipient: 'aurora', refundTo: REFUND, deadline: live.quoteRequest.deadline };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const answer = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

// A test key standing in for 1Click's, so request fields can be changed and still carry a valid signature.
const keys = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
const testSigner = ed25519B58(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
async function signed(edit: (r: typeof live) => void) {
  const r = clone(live);
  edit(r);
  r.signature = ed25519B58(new Uint8Array(await crypto.subtle.sign('Ed25519', keys.privateKey, await quoteSignedBytes(r))));
  return r;
}

describe('funding quote request (T-019)', () => {
  it('asks for EXACT_OUTPUT NEAR USDC into the connected account, refunds to the sender on the origin chain', () => {
    expect(fundingRequest(false, { ...liveArgs, recipient: 'sender.near' })).toEqual({
      dry: false, swapType: 'EXACT_OUTPUT', slippageTolerance: 100,
      originAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', depositType: 'ORIGIN_CHAIN',
      destinationAsset: NEAR_USDC_ASSET, amount: '10000000',
      recipient: 'sender.near', recipientType: 'DESTINATION_CHAIN',
      refundTo: REFUND, refundType: 'ORIGIN_CHAIN', deadline: liveArgs.deadline,
    });
  });
  it('offers the payout leg\'s three pinned chains', () => {
    expect(FUNDING_CHAINS.map((c) => c.name)).toEqual(['Base', 'Arbitrum', 'Ethereum']);
  });
});

describe('limits at the boundary', () => {
  it('1,000 USDC per quote: 1,000 passes, 1,000.000001 is refused before any request', async () => {
    expect(fundingCapError(1_000_000_000n)).toBeNull();
    expect(fundingCapError(1_000_000_001n)).toMatch(/up to 1,000 USDC/);
    let asked = false;
    await expect(getFundingQuote(true, { ...liveArgs, amount: '1000000001' }, async () => ((asked = true), new Response('{}')))).rejects.toThrow(/up to 1,000 USDC/);
    expect(asked).toBe(false);
  });
  it('2% loss: paying 100 for 98 (2.00%) passes, 100 for 97.99 (2.01%) does not', () => {
    expect(fundingWithinLossBound('100000000', '98000000', 6)).toBe(true);
    expect(fundingWithinLossBound('100000000', '97990000', 6)).toBe(false);
    expect(fundingWithinLossBound('100000001', '98000000', 6)).toBe(false); // one base unit over
  });
  it('a signed quote over the bound is refused with its own sentence', async () => {
    const r = await signed((x) => { x.quote.amountIn = '10300000'; });
    await expect(getFundingQuote(true, liveArgs, answer(r), testSigner)).rejects.toThrow(TOO_COSTLY);
  });
});

describe('quote signature, checked in the browser with the pinned key', () => {
  it('passes on the live 1Click response', async () => {
    await expect(verifyQuoteSignature(live)).resolves.toBeUndefined();
    const q = await getFundingQuote(true, liveArgs, answer(live));
    expect(q).toMatchObject({ amountIn: '10102388', amountOut: '10000000', fee: '102388', timeEstimate: 35 });
    expect(q.depositAddress).toBeUndefined();
  });
  it('fails on one changed figure, a missing signature, or another key', async () => {
    const changed = clone(live);
    changed.quote.amountIn = '10102389';
    await expect(getFundingQuote(true, liveArgs, answer(changed))).rejects.toThrow(CANNOT_CHECK);
    const unsigned = clone(live) as Partial<typeof live>;
    delete unsigned.signature;
    await expect(getFundingQuote(true, liveArgs, answer(unsigned))).rejects.toThrow(CANNOT_CHECK);
    await expect(getFundingQuote(true, liveArgs, answer(live), testSigner)).rejects.toThrow(QuoteError);
  });
  it('a validly signed quote for another recipient, refund address, swap type or amount is refused', async () => {
    for (const edit of [
      (x: typeof live) => { x.quoteRequest.recipient = 'thief.near'; },
      (x: typeof live) => { x.quoteRequest.refundTo = '0x' + '1'.repeat(40); },
      (x: typeof live) => { x.quoteRequest.swapType = 'EXACT_INPUT'; },
      (x: typeof live) => { x.quote.amountOut = '9000000'; },
    ]) {
      await expect(getFundingQuote(true, liveArgs, answer(await signed(edit)), testSigner)).rejects.toThrow(CANNOT_CHECK);
    }
    await expect(getFundingQuote(true, liveArgs, answer(await signed(() => {})), testSigner)).resolves.toMatchObject({ amountOut: '10000000' });
  });
  it('a real quote needs an EVM deposit address', async () => {
    const real = (addr?: string) => signed((x) => {
      x.quoteRequest.dry = false;
      Object.assign(x.quote, { depositAddress: addr, deadline: '2026-11-14T16:18:02.000Z', timeEstimate: 35 });
    });
    const ok = await getFundingQuote(false, liveArgs, answer(await real('0x76b4c56085ED136a8744D52bE956396624a730E8')), testSigner);
    expect(ok).toMatchObject({ depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8', deadline: '2026-11-14T16:18:02.000Z' });
    await expect(getFundingQuote(false, liveArgs, answer(await real('a'.repeat(64))), testSigner)).rejects.toThrow(CANNOT_CHECK);
  });
  it('1Click\'s own refusal is shown in plain words, never raw', async () => {
    await expect(getFundingQuote(true, liveArgs, answer({ message: 'Amount is too low for bridge, try at least 1500000' }, 400))).rejects.toThrow(/too low to fund/);
    await expect(getFundingQuote(true, liveArgs, answer({ message: 'tokenIn is not supported' }, 400))).rejects.toThrow(/cannot fund this right now/);
  });
});

describe('each status on the funding screen', () => {
  const dep = '0x76b4c56085ED136a8744D52bE956396624a730E8';
  const line = (status: StatusView['status']) => describeFunding({ status }, 'Base', 'sender.near', REFUND, dep);
  it.each([
    ['PENDING_DEPOSIT', 'Waiting for your USDC on Base.', false],
    ['KNOWN_DEPOSIT_TX', 'Your deposit is on Base. Waiting for it to confirm.', false],
    ['PROCESSING', 'Converting it to USDC on NEAR.', false],
    ['SUCCESS', 'Arrived: the USDC is in sender.near on NEAR.', true],
    ['INCOMPLETE_DEPOSIT', 'The deposit was less than the quote. 1Click refunds it to 0x5aAe…1BeAed on Base by its deadline.', false],
    ['REFUNDED', 'Refunded to 0x5aAe…1BeAed on Base.', true],
    ['FAILED', `1Click is handling this manually, reference ${dep}.`, true],
  ] as const)('%s', (status, text, done) => {
    expect(line(status)).toMatchObject({ text, done });
  });
  it('FAILED never promises a refund; anything new keeps polling', () => {
    expect(line('FAILED').text).not.toMatch(/refund|back/i);
    expect(describeFunding({ status: 'NEW_THING' as never }, 'Base', 'a', REFUND, dep)).toMatchObject({ text: 'Still processing at 1Click.', done: false });
  });
  it('the poller stops at a final status', async () => {
    const seq: StatusView[] = [{ status: 'PENDING_DEPOSIT' }, { status: 'PROCESSING' }, { status: 'SUCCESS' }];
    const seen: string[] = [];
    const end = await followFunding(dep, (s) => (seen.push(s.status), describeFunding(s, 'Base', 'a', REFUND, dep).done), () => false, async () => seq.shift() ?? null, async () => {});
    expect(end).toBe('done');
    expect(seen).toEqual(['PENDING_DEPOSIT', 'PROCESSING', 'SUCCESS']);
  });
});

describe('refund address confirmation and the saved funding', () => {
  it('needs the last 6 characters, any case', () => {
    expect(refundConfirmed(REFUND, '1beaed')).toBe(true);
    expect(refundConfirmed(REFUND, ' 1BeAed ')).toBe(true);
    expect(refundConfirmed(REFUND, '1beae')).toBe(false);
    expect(refundConfirmed('', '')).toBe(false);
  });
  it('survives a reload and is cleared on request', () => {
    const m = new Map<string, string>();
    const store = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as Storage;
    const f = { chainKey: 'base', depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8', refundTo: REFUND, amountIn: '10102388', amountInFormatted: '10.102388', amountOut: '10000000', deadline: 'x' };
    saveFunding('c', 'sender.near', f, store);
    expect(loadFunding('c', 'sender.near', store)).toEqual(f);
    expect(loadFunding('c', 'other.near', store)).toBeNull();
    saveFunding('c', 'sender.near', null, store);
    expect(loadFunding('c', 'sender.near', store)).toBeNull();
  });
});
