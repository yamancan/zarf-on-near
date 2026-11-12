import { describe, expect, it } from 'vitest';
// Recorded 2026-11-10 from GET /v0/status for a real, never-funded mainnet quote (spike S3).
import recorded from './fixtures/1click-status-pending.json';
import {
  checkIntentsStatus, ed25519B58, fetchIntentsStatus, IntentsError, quoteSignedBytes, verifyQuoteSignature, type IntentsClaim,
} from '../src/intents';

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

describe('checkIntentsStatus: pinned assets and the loss bound', () => {
  it('refuses a lookalike asset even when the quote and the claim agree on it', () => {
    const fake = 'nep141:base-0x1c4a802fd6b591bb71daa01d8335e43719048b24.omft.near'; // sUSDC, listed by 1Click
    const s = mutate((x) => (x.quoteResponse.quoteRequest.destinationAsset = fake));
    expect(code(s, { ...claim, destinationAsset: fake })).toBe('INTENTS_WRONG_DESTINATION_ASSET');
  });
  it('requires minAmountOut to keep 98% of the amount (6-decimal USDC)', () => {
    expect(code(mutate((x) => (x.quoteResponse.quote.minAmountOut = '1960000')))).toBeUndefined(); // exactly 98% (2.00% loss)
    expect(code(mutate((x) => (x.quoteResponse.quote.minAmountOut = '1959999')))).toBe('INTENTS_LOSS_TOO_HIGH');
    expect(code(mutate((x) => (x.quoteResponse.quote.minAmountOut = '1959800')))).toBe('INTENTS_LOSS_TOO_HIGH'); // 2.01%
    expect(code(mutate((x) => delete x.quoteResponse.quote.minAmountOut))).toBe('INTENTS_MALFORMED');
  });
  it('refuses the zero address as recipient', () => {
    const zero = '0x' + '0'.repeat(40);
    expect(code(mutate((x) => (x.quoteResponse.quoteRequest.recipient = zero)), { ...claim, recipient: zero })).toBe('INTENTS_WRONG_RECIPIENT');
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

describe('T-001: 1,000 USDC cross-chain cap (verifier)', () => {
  const at = (amount: string, minOut: string) => mutate((x) => {
    x.quoteResponse.quoteRequest.amount = amount;
    x.quoteResponse.quote.minAmountOut = minOut;
  });
  it('1,000 USDC passes; 1,000.000001 is refused with INTENTS_AMOUNT_TOO_HIGH', () => {
    expect(code(at('1000000000', '1000000000'), { ...claim, amount: '1000000000' })).toBeUndefined();
    expect(code(at('1000000001', '1000000001'), { ...claim, amount: '1000000001' })).toBe('INTENTS_AMOUNT_TOO_HIGH');
  });
});

describe('T-001: the loss check is exact, no truncation (Duo P2)', () => {
  // 98% of 1.000005 USDC is 0.9800049: 980005 base units keeps it, 980004 does not.
  const odd = (minOut: string) => mutate((x) => { x.quoteResponse.quoteRequest.amount = '1000005'; x.quoteResponse.quote.minAmountOut = minOut; });
  it('odd amounts at the 2% boundary', () => {
    expect(code(odd('980005'), { ...claim, amount: '1000005' })).toBeUndefined();
    expect(code(odd('980004'), { ...claim, amount: '1000005' })).toBe('INTENTS_LOSS_TOO_HIGH');
  });
});

describe('verifyQuoteSignature (1Click quote signature)', () => {
  const sigCode = async (status: unknown, signer?: string): Promise<string | undefined> => {
    try {
      await verifyQuoteSignature(status, signer);
      return undefined;
    } catch (e) {
      if (e instanceof IntentsError) return e.code;
      throw e;
    }
  };
  type Resp = { quoteResponse: Record<string, unknown> & { quoteRequest: Record<string, unknown>; quote: Record<string, unknown> } };
  const edit = (fn: (s: Resp) => void): unknown => {
    const s = structuredClone(recorded) as unknown as Resp;
    fn(s);
    return s;
  };
  // A test key that re-signs an edited quote exactly as 1Click would.
  const testKey = async () => {
    const k = (await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify'])) as CryptoKeyPair;
    const pub = ed25519B58(new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey)));
    const resign = async (s: unknown) => {
      const r = (s as Resp).quoteResponse;
      r.signature = ed25519B58(new Uint8Array(await crypto.subtle.sign('Ed25519', k.privateKey, await quoteSignedBytes(s))));
      return s;
    };
    return { pub, resign };
  };

  it("accepts the recorded quote: 1Click's real signature under the pinned key", async () => {
    expect(await sigCode(recorded)).toBeUndefined();
  });

  it.each([
    ['depositAddress', (s: Resp) => (s.quoteResponse.quote.depositAddress = 'e'.repeat(64))],
    ['minAmountOut', (s: Resp) => (s.quoteResponse.quote.minAmountOut = '1')],
    ['deadline', (s: Resp) => (s.quoteResponse.quote.deadline = '2030-01-01T00:00:00.000Z')],
    ['recipient', (s: Resp) => (s.quoteResponse.quoteRequest.recipient = '0x' + '1'.repeat(40))],
    ['refundTo', (s: Resp) => (s.quoteResponse.quoteRequest.refundTo = 'someone.near')],
    ['amount', (s: Resp) => (s.quoteResponse.quoteRequest.amount = '1')],
    ['timestamp', (s: Resp) => (s.quoteResponse.timestamp = '2026-11-11T13:02:16.077Z')],
  ])('refuses a quote whose signed %s was changed', async (_, fn) => {
    expect(await sigCode(edit(fn))).toBe('INTENTS_BAD_SIGNATURE');
  });

  it.each([
    ['no signature', (s: Resp) => delete s.quoteResponse.signature],
    ['an empty signature', (s: Resp) => (s.quoteResponse.signature = '')],
    ['a null signature', (s: Resp) => (s.quoteResponse.signature = null)],
    ['no timestamp', (s: Resp) => delete s.quoteResponse.timestamp],
  ])('refuses a quote with %s as unsigned', async (_, fn) => {
    expect(await sigCode(edit(fn))).toBe('INTENTS_QUOTE_UNSIGNED');
  });

  it.each([
    ['not base58', 'ed25519:0OIl'],
    ['too short', 'ed25519:3kS4dLJnhLVr'],
    ['all ones', 'ed25519:' + '1'.repeat(64)],
  ])('refuses a signature that is %s', async (_, sig) => {
    expect(await sigCode(edit((s) => (s.quoteResponse.signature = sig)))).toBe('INTENTS_BAD_SIGNATURE');
  });

  it('refuses a quote signed by any key other than the pinned one', async () => {
    const { resign } = await testKey();
    expect(await sigCode(await resign(edit(() => {})))).toBe('INTENTS_BAD_SIGNATURE');
  });

  it('verifies against the given key, and drops unsigned fields from the message (dry and non-dry)', async () => {
    const { pub, resign } = await testKey();
    expect(await sigCode(await resign(edit(() => {})), pub)).toBeUndefined();
    // appFees, depositMode and confidentiality are not signed by 1Click: changing them keeps the signature valid.
    const signed = await resign(edit(() => {}));
    (signed as Resp).quoteResponse.quoteRequest.appFees = [];
    expect(await sigCode(signed, pub)).toBeUndefined();
    // A dry quote signs only the priced fields: the deposit address is outside the message.
    const dry = await resign(edit((s) => (s.quoteResponse.quoteRequest.dry = true)));
    (dry as Resp).quoteResponse.quote.depositAddress = 'f'.repeat(64);
    expect(await sigCode(dry, pub)).toBeUndefined();
    // The real 1Click signature does not verify under another key.
    expect(await sigCode(recorded, pub)).toBe('INTENTS_BAD_SIGNATURE');
  });
});
