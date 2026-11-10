import { describe, expect, it, vi } from 'vitest';
// Subset of GET /v0/tokens recorded 2026-11-11; the status body is the verifier's recorded fixture.
import tokens from './fixtures/1click-tokens.json';
import pending from './fixtures/1click-status-pending.json';
import { describeStatus, evmAddressError, getQuote, getStatus, loadPayout, lossBps, savePayout, NEAR_USDC_ASSET, PAYOUT_CHAINS, QuoteError, resolveAssets } from './intents';

const json = (body: unknown, status = 200) => vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe('evmAddressError (EIP-55)', () => {
  it.each([
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', // EIP-55 spec examples
    '0x' + 'ab'.repeat(20), '0x' + 'AB'.repeat(20),
  ])('accepts %s', (a) => expect(evmAddressError(a)).toBeNull());
  it('refuses a mixed-case address whose checksum is off by one letter', () => {
    expect(evmAddressError('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toMatch(/typo/);
  });
  it.each(['', '0x123', '5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0x' + 'g'.repeat(40), 'alice.near'])('refuses the format of %j', (a) =>
    expect(evmAddressError(a)).toMatch(/full address/));
});

describe('resolveAssets', () => {
  it('keeps the allow-list order (Base first) and drops anything not listed', async () => {
    const got = await resolveAssets(json(tokens));
    expect(got.map((a) => [a.chain.key, a.assetId, a.decimals])).toEqual([
      ['base', 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', 6],
      ['arb', 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near', 6],
      ['eth', 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near', 6],
    ]);
  });
  it('hides a chain 1Click stops listing', async () => {
    expect((await resolveAssets(json(tokens.filter((t) => t.blockchain !== 'arb')))).map((a) => a.chain.key)).toEqual(['base', 'eth']);
  });
  it('every listed chain is memo-free EVM (a memo chain needs its own review)', () => {
    for (const c of PAYOUT_CHAINS) expect(c.addressError('0x' + 'ab'.repeat(20))).toBeNull();
  });
});

describe('getQuote', () => {
  const args = { amount: '2000000', assetId: 'nep141:base-x', recipient: '0x' + 'ab'.repeat(20), refundTo: 'sender.near', deadline: '2026-11-12T00:00:00.000Z' };
  it('sends exactly the fields the verifier accepts, refunding to the sender on NEAR', async () => {
    const f = json({ quote: { amountOut: '1997398', amountOutFormatted: '1.997398', minAmountOut: '1977424', timeEstimate: 22 } }, 201);
    await getQuote(true, args, f);
    const body = JSON.parse(f.mock.calls[0][1]!.body as string);
    expect(body).toEqual({
      dry: true, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: NEAR_USDC_ASSET, depositType: 'ORIGIN_CHAIN',
      destinationAsset: 'nep141:base-x', amount: '2000000', recipient: args.recipient, recipientType: 'DESTINATION_CHAIN',
      refundTo: 'sender.near', refundType: 'ORIGIN_CHAIN', deadline: args.deadline,
    });
  });
  it("passes 1Click's own message on a 4xx", async () => {
    await expect(getQuote(true, args, json({ message: 'Amount is too low for bridge, try at least 2429' }, 400))).rejects.toEqual(
      new QuoteError('Amount is too low for bridge, try at least 2429'));
  });
  it('a real quote must carry a 64-hex deposit address', async () => {
    await expect(getQuote(false, args, json({ quote: { amountOut: '1' } }, 201))).rejects.toThrow('no deposit address');
    const q = await getQuote(false, args, json({ quote: { amountOut: '1', depositAddress: 'd'.repeat(64) } }, 201));
    expect(q.depositAddress).toBe('d'.repeat(64));
  });
  it('a 5xx is an outage, not a refusal', async () => {
    await expect(getQuote(true, args, json({}, 503))).rejects.not.toBeInstanceOf(QuoteError);
  });
});

describe('lossBps', () => {
  it('measures the worst case against the amount, across decimals', () => {
    expect(lossBps('1000000', '987424', 6)).toBe(125); // 1 USDC, audit dry quote
    expect(lossBps('100000', '96600', 6)).toBe(340);
    expect(lossBps('1000000', '9900000', 7)).toBe(100); // 7-decimal destination (Stellar USDC)
    expect(lossBps('1000000', '1000001', 6)).toBe(0);
  });
});

describe('getStatus and describeStatus', () => {
  it('reads the recorded pending status; 404 is null', async () => {
    expect((await getStatus('d'.repeat(64), json(pending)))!.status).toBe('PENDING_DEPOSIT');
    expect(await getStatus('d'.repeat(64), json({}, 404))).toBeNull();
  });
  it('maps every status to receipt copy', () => {
    const d = (status: string, extra = {}) => describeStatus({ status: status as never, ...extra }, 'Base', 'sender.near');
    expect(d('PENDING_DEPOSIT')).toMatchObject({ done: false, ok: true, text: 'Sent from NEAR, waiting for the bridge.' });
    expect(d('KNOWN_DEPOSIT_TX').done).toBe(false);
    expect(d('PROCESSING').text).toBe('Paying out on Base.');
    expect(d('SUCCESS', { amountOutFormatted: '1.99' })).toEqual({ done: true, ok: true, text: 'Arrived on Base: 1.99 USDC.' });
    expect(d('REFUNDED')).toMatchObject({ done: true, ok: false, text: 'Not delivered. The USDC went back to sender.near on NEAR.' });
    expect(d('FAILED')).toMatchObject({ done: true, ok: false });
    expect(d('INCOMPLETE_DEPOSIT').text).toMatch(/contact the sender/);
  });
});

describe('savePayout / loadPayout (receipt reload)', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
  };
  const p = { depositAddress: 'd'.repeat(64), txHash: 'tx', chainName: 'Base', recipient: '0x' + 'ab'.repeat(20), refundTo: 'sender.near', amountOutFormatted: '9.99' };
  it('round-trips per campaign and commitment', () => {
    const s = mem();
    savePayout('7', 'c1', p, s);
    expect(loadPayout('7', 'c1', s)).toEqual(p);
    expect(loadPayout('7', 'c2', s)).toBeNull();
  });
  it('tolerates garbage and a storage that throws', () => {
    const s = mem();
    s.setItem('zarf-near:payout:7/c1', '{');
    expect(loadPayout('7', 'c1', s)).toBeNull();
    s.setItem('zarf-near:payout:7/c1', JSON.stringify({ ...p, depositAddress: 'alice.near' }));
    expect(loadPayout('7', 'c1', s)).toBeNull();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(() => savePayout('7', 'c1', p, broken)).not.toThrow();
    expect(loadPayout('7', 'c1', broken)).toBeNull();
  });
});
