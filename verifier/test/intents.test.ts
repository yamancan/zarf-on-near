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
  refundTo: '0x2527d02599ba641c19fea793cd0f167589a0f10d',
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
    ['refund to origin chain', (s) => (s.quoteResponse.quoteRequest.refundType = 'ORIGIN_CHAIN'), 'INTENTS_WRONG_REFUND'],
    ['refund to someone else', (s) => (s.quoteResponse.quoteRequest.refundTo = 'attacker.near'), 'INTENTS_WRONG_REFUND'],
    ['refunds begin at expiry', (s) => (s.quoteResponse.quoteRequest.deadline = new Date(Number(BigInt(claim.expiresAtNs) / 1_000_000n)).toISOString()), 'INTENTS_QUOTE_EXPIRES_FIRST'],
    ['address inactive before expiry', (s) => (s.quoteResponse.quote.deadline = '2026-11-10T00:00:00.000Z'), 'INTENTS_QUOTE_EXPIRES_FIRST'],
    ['unparseable deadline', (s) => (s.quoteResponse.quote.deadline = 'soon'), 'INTENTS_BAD_DEADLINE'],
    ['no quote', (s) => Reflect.deleteProperty(s.quoteResponse, 'quote'), 'INTENTS_MALFORMED'],
  ])('refuses %s', (_name, fn, expected) => {
    expect(code(mutate(fn))).toBe(expected);
  });

  it('refuses a non-canonical leaf amount', () => {
    expect(code(recorded, { ...claim, amount: '2e6' })).toBe('INTENTS_BAD_AMOUNT');
  });

  it('refuses a refund account that differs from the claim', () => {
    expect(code(recorded, { ...claim, refundTo: 'recipient.near' })).toBe('INTENTS_WRONG_REFUND');
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
