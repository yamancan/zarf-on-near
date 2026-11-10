import { describe, expect, it } from 'vitest';
// Recorded 2026-11-10 from GET /v0/status for a real, never-funded mainnet quote (spike S3).
import recorded from './fixtures/1click-status-pending.json';
import { checkIntentsStatus, fetchIntentsStatus, IntentsError, type IntentsClaim } from '../src/intents';

const ns = (iso: string) => (BigInt(Date.parse(iso)) * 1_000_000n).toString();
const QR_DEADLINE = recorded.quoteResponse.quoteRequest.deadline;

const claim: IntentsClaim = {
  depositAddress: recorded.quoteResponse.quote.depositAddress,
  amount: '2000000',
  destinationAsset: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near',
  recipient: '0x1111111111111111111111111111111111111112',
  campaignSender: 'intents.near', // the recorded quote's refundTo: an existing named account
  expiresAtNs: (BigInt(ns(QR_DEADLINE)) - 1_000_000_000n).toString(), // 1 s before refunds begin
};

type Status = { status: unknown; quoteResponse: { quoteRequest: Record<string, unknown>; quote: Record<string, unknown> } };
const mutate = (fn: (s: Status) => void): unknown => {
  const s = structuredClone(recorded) as unknown as Status;
  fn(s);
  return s;
};

const code = (status: unknown, c: IntentsClaim = claim): string | undefined => {
  try {
    checkIntentsStatus(status, c);
    return undefined;
  } catch (e) {
    if (e instanceof IntentsError) return e.code;
    throw e;
  }
};

describe('checkIntentsStatus', () => {
  it('accepts the recorded quote that matches the claim', () => {
    expect(code(recorded)).toBeUndefined();
  });

  it('compares EVM recipients case-insensitively', () => {
    expect(code(recorded, { ...claim, recipient: claim.recipient.toLowerCase() })).toBeUndefined();
  });

  it.each<[string, (s: Status) => void, string]>([
    ['another deposit address', (s) => (s.quoteResponse.quote.depositAddress = 'b'.repeat(64)), 'INTENTS_DEPOSIT_ADDRESS_MISMATCH'],
    ['already deposited', (s) => (s.status = 'PROCESSING'), 'INTENTS_NOT_PENDING'],
    ['already paid', (s) => (s.status = 'SUCCESS'), 'INTENTS_NOT_PENDING'],
    ['refunded', (s) => (s.status = 'REFUNDED'), 'INTENTS_NOT_PENDING'],
    ['a dry quote', (s) => (s.quoteResponse.quoteRequest.dry = true), 'INTENTS_MALFORMED'],
    ['origin is not NEAR USDC', (s) => (s.quoteResponse.quoteRequest.originAsset = 'nep141:wrap.near'), 'INTENTS_WRONG_ORIGIN_ASSET'],
    ['deposit inside Intents', (s) => (s.quoteResponse.quoteRequest.depositType = 'INTENTS'), 'INTENTS_WRONG_DEPOSIT_TYPE'],
    ['memo deposit mode', (s) => (s.quoteResponse.quoteRequest.depositMode = 'MEMO'), 'INTENTS_MEMO_REQUIRED'],
    ['a deposit memo', (s) => (s.quoteResponse.quote.depositMemo = '1'), 'INTENTS_MEMO_REQUIRED'],
    ['EXACT_OUTPUT', (s) => (s.quoteResponse.quoteRequest.swapType = 'EXACT_OUTPUT'), 'INTENTS_WRONG_SWAP_TYPE'],
    ['amount above the leaf', (s) => (s.quoteResponse.quoteRequest.amount = '2000001'), 'INTENTS_AMOUNT_MISMATCH'],
    ['amount below the leaf', (s) => (s.quoteResponse.quoteRequest.amount = '1999999'), 'INTENTS_AMOUNT_MISMATCH'],
    ['non-canonical amount', (s) => (s.quoteResponse.quoteRequest.amount = '02000000'), 'INTENTS_AMOUNT_MISMATCH'],
    ['numeric amount', (s) => (s.quoteResponse.quoteRequest.amount = 2000000), 'INTENTS_AMOUNT_MISMATCH'],
    ['another destination asset', (s) => (s.quoteResponse.quoteRequest.destinationAsset = 'nep141:eth.omft.near'), 'INTENTS_WRONG_DESTINATION_ASSET'],
    ['another recipient', (s) => (s.quoteResponse.quoteRequest.recipient = '0x' + '1'.repeat(40)), 'INTENTS_WRONG_RECIPIENT'],
    ['recipient inside Intents', (s) => (s.quoteResponse.quoteRequest.recipientType = 'INTENTS'), 'INTENTS_WRONG_RECIPIENT'],
    ['virtual-chain reroute', (s) => (s.quoteResponse.quoteRequest.virtualChainRecipient = '0x' + '1'.repeat(40)), 'INTENTS_WRONG_RECIPIENT'],
    ['ft_transfer_call reroute', (s) => (s.quoteResponse.quoteRequest.customRecipientMsg = 'x.near'), 'INTENTS_WRONG_RECIPIENT'],
    ['refund inside Intents', (s) => (s.quoteResponse.quoteRequest.refundType = 'INTENTS'), 'INTENTS_WRONG_REFUND'],
    ['refund to someone else', (s) => (s.quoteResponse.quoteRequest.refundTo = 'attacker.near'), 'INTENTS_WRONG_REFUND'],
    ['refunds begin at expiry', (s) => (s.quoteResponse.quoteRequest.deadline = new Date(Number(BigInt(claim.expiresAtNs) / 1_000_000n)).toISOString()), 'INTENTS_QUOTE_EXPIRES_FIRST'],
    ['address inactive before expiry', (s) => (s.quoteResponse.quote.deadline = '2026-11-10T00:00:00.000Z'), 'INTENTS_QUOTE_EXPIRES_FIRST'],
    ['unparseable deadline', (s) => (s.quoteResponse.quote.deadline = 'soon'), 'INTENTS_BAD_DEADLINE'],
    ['no quote', (s) => Reflect.deleteProperty(s.quoteResponse, 'quote'), 'INTENTS_MALFORMED'],
    ['virtual-chain refund reroute', (s) => (s.quoteResponse.quoteRequest.virtualChainRefundRecipient = '0x' + '1'.repeat(40)), 'INTENTS_WRONG_RECIPIENT'],
    ['an extra app fee', (s) => (s.quoteResponse.quoteRequest.appFees = [...(s.quoteResponse.quoteRequest.appFees as unknown[]), { recipient: 'attacker.near', fee: 9900 }]), 'INTENTS_UNEXPECTED_FEE'],
    ['an app fee to someone else', (s) => (s.quoteResponse.quoteRequest.appFees = [{ recipient: 'attacker.near', fee: 1 }]), 'INTENTS_UNEXPECTED_FEE'],
    ['the keyless fee above its cap', (s) => (s.quoteResponse.quoteRequest.appFees = [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 26 }]), 'INTENTS_UNEXPECTED_FEE'],
    ['the keyless fee twice', (s) => (s.quoteResponse.quoteRequest.appFees = [{ recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 1 }, { recipient: '5880ad2b362620fadf759cbceb1cd5737ce8c6ed7fb8e9942881e6731f9247dd', fee: 1 }]), 'INTENTS_UNEXPECTED_FEE'],
    ['appFees not an array', (s) => (s.quoteResponse.quoteRequest.appFees = { recipient: 'x', fee: 1 }), 'INTENTS_UNEXPECTED_FEE'],
    ['slippage above 1%', (s) => (s.quoteResponse.quoteRequest.slippageTolerance = 101), 'INTENTS_SLIPPAGE_TOO_HIGH'],
    ['slippage of 100%', (s) => (s.quoteResponse.quoteRequest.slippageTolerance = 10000), 'INTENTS_SLIPPAGE_TOO_HIGH'],
    ['negative slippage', (s) => (s.quoteResponse.quoteRequest.slippageTolerance = -1), 'INTENTS_SLIPPAGE_TOO_HIGH'],
    ['a referral', (s) => (s.quoteResponse.quoteRequest.referral = 'somewallet'), 'INTENTS_UNEXPECTED_FEE'],
    ['quoteRequest is an array', (s) => (s.quoteResponse.quoteRequest = [] as unknown as Record<string, unknown>), 'INTENTS_MALFORMED'],
    ['slippage missing', (s) => Reflect.deleteProperty(s.quoteResponse.quoteRequest, 'slippageTolerance'), 'INTENTS_SLIPPAGE_TOO_HIGH'],
    ['an unknown request field', (s) => (s.quoteResponse.quoteRequest.newRoutingHint = 'x'), 'INTENTS_UNKNOWN_FIELD'],
    ['a confidential quote', (s) => (s.quoteResponse.quoteRequest.confidentiality = 'basic'), 'INTENTS_MALFORMED'],
  ])('refuses %s', (_name, fn, expected) => {
    expect(code(mutate(fn))).toBe(expected);
  });

  it('accepts a quote with no app fees and an unknown key set to null', () => {
    expect(code(mutate((s) => Reflect.deleteProperty(s.quoteResponse.quoteRequest, 'appFees')))).toBeUndefined();
    expect(code(mutate((s) => (s.quoteResponse.quoteRequest.newRoutingHint = null)))).toBeUndefined();
  });

  it('compares non-EVM addresses exactly', () => {
    const sol = '13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK';
    const solQuote = mutate((s) => (s.quoteResponse.quoteRequest.recipient = sol));
    expect(code(solQuote, { ...claim, recipient: sol })).toBeUndefined();
    expect(code(solQuote, { ...claim, recipient: sol.toLowerCase() })).toBe('INTENTS_WRONG_RECIPIENT');
    const nearRefund = mutate((s) => (s.quoteResponse.quoteRequest.refundTo = 'Alice.near'));
    expect(code(nearRefund, { ...claim, campaignSender: 'alice.near' })).toBe('INTENTS_WRONG_REFUND');
  });

  it.each(['abc', '0x10', '1e18', '-1', ''])('refuses expiresAtNs %j with a coded error', (expiresAtNs) => {
    expect(code(recorded, { ...claim, expiresAtNs })).toBe('INTENTS_BAD_DEADLINE');
  });

  it('refuses a non-canonical leaf amount', () => {
    expect(code(recorded, { ...claim, amount: '2e6' })).toBe('INTENTS_BAD_AMOUNT');
  });

  it('refuses a refund to anyone but the campaign sender', () => {
    expect(code(recorded, { ...claim, campaignSender: 'sender.near' })).toBe('INTENTS_WRONG_REFUND');
  });

  it('refuses a non-object body', () => {
    expect(code(null)).toBe('INTENTS_MALFORMED');
    expect(code({ status: 'PENDING_DEPOSIT' })).toBe('INTENTS_MALFORMED');
  });
});

describe('fetchIntentsStatus', () => {
  it('requests the status by deposit address and returns the body', async () => {
    const urls: string[] = [];
    const body = await fetchIntentsStatus(claim.depositAddress, async (u) => {
      urls.push(u);
      return Response.json(recorded);
    });
    expect(urls).toEqual([`https://1click.chaindefuser.com/v0/status?depositAddress=${claim.depositAddress}`]);
    expect(body).toEqual(recorded);
  });

  it('passes a timeout signal', async () => {
    let signal: AbortSignal | null | undefined;
    await fetchIntentsStatus(claim.depositAddress, async (_u, init) => {
      signal = init.signal;
      return Response.json(recorded);
    });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(62)}&x`, `${'a'.repeat(62)}#x`, 'alice.near'])(
    'refuses deposit address %j before fetching',
    async (addr) => {
      let called = false;
      const p = fetchIntentsStatus(addr, async () => {
        called = true;
        return Response.json(recorded);
      });
      await expect(p).rejects.toMatchObject({ code: 'INTENTS_BAD_DEPOSIT_ADDRESS' });
      expect(called).toBe(false);
    },
  );

  it('maps 404 to INTENTS_QUOTE_NOT_FOUND', async () => {
    const p = fetchIntentsStatus('b'.repeat(64), async () => Response.json({ statusCode: 404 }, { status: 404 }));
    await expect(p).rejects.toMatchObject({ code: 'INTENTS_QUOTE_NOT_FOUND' });
  });

  it('throws a plain error on other failures', async () => {
    const p = fetchIntentsStatus('b'.repeat(64), async () => new Response('', { status: 503 }));
    await expect(p).rejects.toThrow('HTTP 503');
    await expect(p).rejects.not.toBeInstanceOf(IntentsError);
  });
});
