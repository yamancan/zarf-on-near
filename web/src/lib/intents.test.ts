import { describe, expect, it, vi } from 'vitest';
// Subset of GET /v0/tokens recorded 2026-11-11; the status body is the verifier's recorded fixture.
import tokens from './fixtures/1click-tokens.json';
// Every USDC-named entry of GET /v0/tokens, recorded 2026-11-14 (T-025): the pinned set is checked against it.
import usdcTokens from './fixtures/1click-tokens-usdc.json';
import pending from './fixtures/1click-status-pending.json';
import { MAX_CROSS_CHAIN_PAYOUT, MAX_LOSS_BPS, payoutCapError, withinLossBound, crossChainOffered, submitDeposit, describeStatus, refusal, evmAddressError, hex64AddressError, solanaAddressError, solanaFormatError, ed25519OnCurve, getQuote, getStatus, loadPayout, lossBps, needsRecheck, nextStep, notReturnedYet, recheckReceipt, savePayout, NEAR_USDC_ASSET, PAYOUT_CHAINS, QuoteError, resolveAssets } from './intents';
import { b58decode } from './oneclickSig';
import { loadReceipt, saveReceipt, shownAmount, type Receipt } from './claim';

const json = (body: unknown, status = 200) => vi.fn(async (_u: string, _i?: RequestInit) => new Response(JSON.stringify(body), { status }));

describe('evmAddressError (EIP-55)', () => {
  it.each([
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359', // EIP-55 spec examples
    '0x' + 'ab'.repeat(20), '0x' + 'AB'.repeat(20),
  ])('accepts %s', (a) => expect(evmAddressError(a)).toBeNull());
  it('refuses a mixed-case address whose checksum is off by one letter', () => {
    expect(evmAddressError('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD')).toMatch(/typo/);
  });
  it('refuses the zero address', () => expect(evmAddressError('0x' + '0'.repeat(40))).toMatch(/zero address/));
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
  it('pins asset ids and decimals: a lookalike USDC listed first, or other decimals, changes nothing', async () => {
    const base = tokens.find((t) => t.blockchain === 'base' && t.symbol === 'USDC')!;
    const lookalike = { ...base, assetId: 'nep141:base-0xdeadbeef.omft.near', contractAddress: '0xdeadbeef' };
    const got = await resolveAssets(json([lookalike, ...tokens.map((t) => ({ ...t, decimals: 18 }))]));
    expect(got[0]).toMatchObject({ assetId: 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near', decimals: 6 });
    expect(got.every((a) => a.decimals === 6)).toBe(true);
    expect((await resolveAssets(json([lookalike]))).length).toBe(0); // only the lookalike listed: hide Base
  });
  it('hides a chain 1Click stops listing', async () => {
    expect((await resolveAssets(json(tokens.filter((t) => t.blockchain !== 'arb')))).map((a) => a.chain.key)).toEqual(['base', 'eth']);
  });
  it('every listed chain accepts an address in its own format (and none needs a memo: a memo chain is not listed)', () => {
    const sample: Record<string, string> = {
      base: EVM, arb: EVM, eth: EVM, op: EVM, pol: EVM, avax: EVM, monad: EVM, sol: SOL, sui: HEX64, aptos: HEX64,
    };
    expect(PAYOUT_CHAINS.map((c) => c.key)).toEqual(Object.keys(sample));
    for (const c of PAYOUT_CHAINS) expect(c.addressError(sample[c.key])).toBeNull();
  });
});

const EVM = '0x' + 'ab'.repeat(20);
const SOL = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const HEX64 = '0x1d8727df513fa2a8785d0834e40b34223daff1affc079574082baadb74b66ee4';

describe('pinned chains (T-025): Circle native USDC only, checked against the recorded /v0/tokens', () => {
  // Circle's contract per chain, developers.circle.com/stablecoins/usdc-contract-addresses, read 2026-11-14.
  const circle: Record<string, string> = {
    base: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', arb: '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    eth: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', op: '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    pol: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', avax: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    monad: '0x754704bc059f8c67012fed69bc8a327a5aafb603', sol: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    sui: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC', aptos: '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b',
  };
  it('each pinned id is listed as USDC, 6 decimals, at Circle\'s own contract', () => {
    for (const c of PAYOUT_CHAINS) {
      const t = usdcTokens.find((x) => x.assetId === c.assetId);
      expect(t, c.key).toMatchObject({ symbol: 'USDC', decimals: 6 });
      expect(t!.contractAddress.toLowerCase(), c.key).toBe(circle[c.key].toLowerCase());
    }
  });
  it('the recorded list routes all ten, Base first; BNB, Gnosis, X Layer (USDC.e), Stellar and deprecated ids never appear', async () => {
    const got = (await resolveAssets(json(usdcTokens))).map((a) => a.chain.key);
    expect(got).toEqual(['base', 'arb', 'eth', 'op', 'pol', 'avax', 'monad', 'sol', 'sui', 'aptos']);
    const pinned = new Set(PAYOUT_CHAINS.map((c) => c.assetId));
    const left = usdcTokens.filter((t) => !pinned.has(t.assetId) && t.blockchain !== 'near').map((t) => `${t.blockchain}:${t.symbol}`);
    expect(left).toEqual(expect.arrayContaining(['bsc:USDC', 'gnosis:USDC', 'xlayer:USDC', 'stellar:USDC', 'pol:USDC(DEPRECATED)', 'avax:USDC(DEPRECATED)']));
  });
});

describe('address validators (T-025)', () => {
  it('Solana: base58 of 32 bytes; not the system program, not the USDC mint, no typos', () => {
    expect(solanaAddressError(SOL)).toBeNull();
    expect(solanaAddressError('13QkxhNMrTPxoCkRdYdJ65tFuwXPhL5gLS2Z5Nr6gjRK')).toBeNull();
    expect(solanaAddressError('11111111111111111111111111111111')).toMatch(/system program/);
    expect(solanaAddressError('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toMatch(/USDC token itself/);
    expect(solanaAddressError(SOL.slice(0, 30))).toMatch(/full Solana address/);
    expect(solanaAddressError(SOL.replace('W', '0'))).toMatch(/full Solana address/); // 0 is not base58
    expect(solanaAddressError('z'.repeat(44))).toMatch(/not a Solana address/); // decodes to more than 32 bytes
    expect(solanaAddressError(EVM)).toMatch(/full Solana address/);
    expect(solanaAddressError('8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR')).toMatch(/not a wallet address/); // off-curve, like a token account
    expect(solanaFormatError('8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR')).toBeNull(); // still a valid deposit-address format
    expect(solanaFormatError('11111111111111111111111111111111')).toMatch(/system program/);
    expect([ed25519OnCurve(b58decode(SOL)), ed25519OnCurve(b58decode('8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR'))]).toEqual([true, false]);
  });
  it('Sui and Aptos: 0x and all 64 hex digits, never zero, no short form', () => {
    expect(hex64AddressError(HEX64)).toBeNull();
    expect(hex64AddressError(HEX64.toUpperCase().replace('0X', '0x'))).toBeNull();
    expect(hex64AddressError('0x1')).toMatch(/64 letters/);
    expect(hex64AddressError(HEX64.slice(0, -1))).toMatch(/64 letters/);
    expect(hex64AddressError('0x' + '0'.repeat(64))).toMatch(/zero address/);
    expect(hex64AddressError(EVM)).toMatch(/64 letters/);
    expect(hex64AddressError(SOL)).toMatch(/64 letters/);
  });
  it('EVM chains refuse Solana and 64-digit addresses', () => {
    expect(evmAddressError(SOL)).toMatch(/40 letters/);
    expect(evmAddressError(HEX64)).toMatch(/40 letters/);
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
    expect(d('PENDING_DEPOSIT')).toMatchObject({ done: false, ok: true, outcome: 'in-transit', text: 'Sent from NEAR, waiting for the bridge.' });
    expect(d('KNOWN_DEPOSIT_TX')).toMatchObject({ done: false, outcome: 'in-transit' });
    expect(d('PROCESSING')).toMatchObject({ text: 'Paying out on Base.', outcome: 'in-transit' });
    expect(d('SUCCESS', { amountOutFormatted: '1.99558' })).toEqual({ done: true, ok: true, outcome: 'paid', text: 'Arrived on Base.' });
    expect(d('REFUNDED')).toMatchObject({ done: true, ok: false, outcome: 'refunded', text: 'Went back to sender.near on NEAR.' });
    expect(d('FAILED')).toMatchObject({ done: true, ok: false, outcome: 'failed', text: 'The bridge reported an error and has not paid out on Base.' });
    expect(d('INCOMPLETE_DEPOSIT')).toEqual({ done: false, ok: false, outcome: 'refunding', text: 'The bridge did not accept the deposit. It refunds sender.near on NEAR by its deadline.' });
  });
  it('never shows the bridge\'s raw refund reason on the surface (critic r3 M4)', () => {
    expect(describeStatus({ status: 'REFUNDED', refundReason: 'route unavailable' }, 'Base', 'sender.near').text).not.toMatch(/route unavailable|\(/);
  });
  it('never promises a refund for FAILED: 1Click documents none (only REFUNDED is "returned")', () => {
    const promise = /goes back|go back|will be returned|is refunded|refunds|returned to|went back/i;
    expect(describeStatus({ status: 'FAILED' }, 'Base', 'sender.near').text).not.toMatch(promise);
    expect(nextStep('failed')).not.toMatch(promise);
  });
  it('keeps polling an unknown status: still processing, not final (round 3 A2)', () => {
    expect(describeStatus({ status: 'SOMETHING_NEW' as never }, 'Base', 'sender.near')).toEqual({ done: false, ok: true, outcome: 'in-transit', text: 'Still processing on the bridge.' });
  });
  it('says what happens next after a payout that did not arrive, without "Keep this page" (round 3 A3, corrected)', () => {
    expect(nextStep('failed')).toBe('Tell the sender. They can ask NEAR Intents support, with the deposit address under Details.');
    expect(nextStep('refunded')).toBe('The sender can send you a new link.');
    expect(nextStep('refunding')).toBe('The sender can send you a new link.');
    expect(nextStep('in-transit')).toBe('');
    expect(nextStep('paid')).toBe('');
    expect(notReturnedYet('sender.near', '12 Nov 2026, 14:02')).toBe('Not returned to sender.near as of the last check (12 Nov 2026, 14:02).');
  });
});

describe('recheckReceipt (a reopened cross-chain record asks the bridge again, round 3 A1)', () => {
  const mem = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } as Storage;
  };
  const K = 'zarf-near-1112.testnet', NOW = Date.UTC(2026, 10, 12, 14, 0);
  const rec: Receipt = { amount: '10000000', destination: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', txHash: '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm', chainName: 'Base', bridge: 'in-transit', depositAddress: 'd'.repeat(64), refundTo: 'sender.near', savedAt: NOW };
  it('asks again only for an unsettled cross-chain record with a deposit address', () => {
    expect(needsRecheck(rec)).toBe(true);
    expect(needsRecheck({ ...rec, bridge: 'failed' })).toBe(true);
    expect(needsRecheck({ ...rec, bridge: 'refunding' })).toBe(true);
    expect(needsRecheck({ ...rec, bridge: 'paid' })).toBe(false);
    expect(needsRecheck({ ...rec, bridge: 'refunded' })).toBe(false);
    expect(needsRecheck({ ...rec, depositAddress: undefined })).toBe(false);
    expect(needsRecheck({ amount: '1', destination: 'alice.testnet', txHash: rec.txHash })).toBe(false);
    expect(needsRecheck(null)).toBe(false);
  });
  it('an in-transit record learns SUCCESS later: saved as paid with the amount the bridge paid', async () => {
    const s = mem();
    saveReceipt(K, '7', 'c', rec, s, NOW);
    const f = json({ status: 'SUCCESS', swapDetails: { amountOutFormatted: '9.99558' } });
    const a = await recheckReceipt(K, '7', 'c', rec, f, s, NOW + 60_000);
    expect(f.mock.calls[0][0]).toContain(`depositAddress=${'d'.repeat(64)}`);
    expect(a.done).toBe(true);
    expect(loadReceipt(K, '7', 'c', s, NOW + 60_000)).toMatchObject({ bridge: 'paid', amountOut: '9.99558', checkedAt: NOW + 60_000 });
    expect(shownAmount(a.r, '10', 'USDC')).toEqual({ value: '9.99', unit: 'USDC' });
  });
  it('learns a refund, and keeps asking while the bridge still processes', async () => {
    const s = mem();
    saveReceipt(K, '7', 'c', rec, s, NOW);
    const busy = await recheckReceipt(K, '7', 'c', rec, json({ status: 'INCOMPLETE_DEPOSIT' }), s, NOW + 1);
    expect(busy).toMatchObject({ done: false, r: { bridge: 'refunding', checkedAt: NOW + 1 } });
    const back = await recheckReceipt(K, '7', 'c', { ...rec, bridge: 'failed' }, json({ status: 'REFUNDED' }), s, NOW + 2);
    expect(back).toMatchObject({ done: true, r: { bridge: 'refunded' } });
    expect(loadReceipt(K, '7', 'c', s, NOW + 2)!.bridge).toBe('refunded');
  });
  it('keeps bridge steps, refund reason and destination transaction after a reload', async () => {
    const s = mem();
    saveReceipt(K, '7', 'c', rec, s, NOW);
    await recheckReceipt(K, '7', 'c', rec, json({ status: 'FAILED', swapDetails: {
      refundReason: 'Destination transfer failed',
      destinationChainTxHashes: [{ hash: '0x1234', explorerUrl: 'https://basescan.org/tx/0x1234' }],
    } }), s, NOW + 1);
    expect(loadReceipt(K, '7', 'c', s, NOW + 2)).toMatchObject({
      bridge: 'failed', bridgeStatus: { status: 'FAILED', refundReason: 'Destination transfer failed',
        destinationTx: { hash: '0x1234', explorerUrl: 'https://basescan.org/tx/0x1234' } },
    });
  });
  it('a failed read or an unknown address changes nothing (the "last checked" time stays)', async () => {
    const s = mem();
    saveReceipt(K, '7', 'c', { ...rec, checkedAt: NOW }, s, NOW);
    await expect(recheckReceipt(K, '7', 'c', rec, json({}, 500), s, NOW + 5)).rejects.toThrow();
    expect(await recheckReceipt(K, '7', 'c', rec, json({}, 404), s, NOW + 5)).toEqual({ r: rec, done: false });
    expect(loadReceipt(K, '7', 'c', s, NOW + 5)!.checkedAt).toBe(NOW);
  });
});

describe('refusal (a refused quote in plain words)', () => {
  it('maps the bridge message, never echoing it', () => {
    expect(refusal('Amount is too low for this route.', 'Base')).toBe('This amount is too low to send to Base. Claim to a NEAR account instead.');
    expect(refusal('The bridge would pay too little: the price moved too far.', 'Base')).toBe('The bridge would pay too little: the price moved too far.');
    expect(refusal('<script>x</script> route gone', 'Arbitrum')).toBe('The bridge cannot pay this out to Arbitrum right now. Claim to a NEAR account instead.');
  });
});

describe('savePayout / loadPayout (receipt reload)', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) } as unknown as Storage;
  };
  const p = { depositAddress: 'd'.repeat(64), txHash: 'tx', chainName: 'Base', recipient: '0x' + 'ab'.repeat(20), refundTo: 'sender.near', amountOutFormatted: '9.99', amount: '10000000' };
  const K = 'zarf-near-1112.testnet';
  it('round-trips per contract, campaign and commitment', () => {
    const s = mem();
    savePayout(K, '7', 'c1', p, s);
    expect(loadPayout(K, '7', 'c1', s)).toEqual(p);
    expect(loadPayout(K, '7', 'c2', s)).toBeNull();
    expect(loadPayout('old-contract.testnet', '7', 'c1', s)).toBeNull(); // round 3: the contract id is in the key
    savePayout(K, '7', 'c3', { ...p, amount: '-1' }, s);
    expect(loadPayout(K, '7', 'c3', s)).toBeNull();
  });
  it('tolerates garbage and a storage that throws', () => {
    const s = mem();
    s.setItem(`zarf-near:payout:${K}/7/c1`, '{');
    expect(loadPayout(K, '7', 'c1', s)).toBeNull();
    s.setItem(`zarf-near:payout:${K}/7/c1`, JSON.stringify({ ...p, depositAddress: 'alice.near' }));
    expect(loadPayout(K, '7', 'c1', s)).toBeNull();
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(() => savePayout(K, '7', 'c1', p, broken)).not.toThrow();
    expect(loadPayout(K, '7', 'c1', broken)).toBeNull();
  });
});

describe('second audit M1: cross-chain gate and deposit submit', () => {
  it('"Another chain" on testnet always; on mainnet only with PUBLIC_CROSS_CHAIN=on', () => {
    expect(crossChainOffered('testnet', undefined)).toBe(true);
    expect(crossChainOffered('mainnet', undefined)).toBe(false);
    expect(crossChainOffered('mainnet', '')).toBe(false);
    expect(crossChainOffered('mainnet', 'true')).toBe(false);
    expect(crossChainOffered('mainnet', 'on')).toBe(true);
  });
  it('submits txHash, depositAddress and the NEAR sender, and ignores a failure', async () => {
    const f = json({}, 200);
    await submitDeposit('d'.repeat(64), 'TX', 'relayer.near', f);
    expect(f.mock.calls[0][0]).toBe('https://1click.chaindefuser.com/v0/deposit/submit');
    expect(JSON.parse(f.mock.calls[0][1]!.body as string)).toEqual({ txHash: 'TX', depositAddress: 'd'.repeat(64), nearSenderAccount: 'relayer.near' });
    await submitDeposit('d'.repeat(64), 'TX', undefined, json({}, 200));
    await expect(submitDeposit('d'.repeat(64), 'TX', 'r', vi.fn(async () => { throw new Error('down'); }))).resolves.toBeUndefined();
  });
});

describe('T-001 limits (web): 2% loss bound and 1,000 USDC cross-chain cap', () => {
  it('the loss bound is 2.00%, exact at the boundary, across decimals', () => {
    expect(MAX_LOSS_BPS).toBe(200);
    expect(withinLossBound('1000000', '980000', 6)).toBe(true); // exactly 2.00%
    expect(withinLossBound('1000000', '979999', 6)).toBe(false); // 2.0001%: no rounding to whole bps
    expect(withinLossBound('1000000', '979900', 6)).toBe(false); // 2.01%
    expect(withinLossBound('1000000', '9800000', 7)).toBe(true); // 7-decimal destination, exactly 2%
    expect(withinLossBound('1000000', '9799999', 7)).toBe(false);
    expect(withinLossBound('1000005', '9800049', 7)).toBe(true); // 1.000005 → 0.9800049: exactly 2%, not truncated away
    expect(withinLossBound('1000005', '9800048', 7)).toBe(false);
    expect(withinLossBound('1000000', '987424', 6)).toBe(true); // 1 USDC, a real dry quote: 1.26%
    expect(withinLossBound('100000', '96602', 6)).toBe(false); // 0.1 USDC, a real dry quote: 3.4%
  });
  it('the cap is 1,000 USDC: 1,000 passes, 1,000.000001 is refused before any quote', () => {
    expect(MAX_CROSS_CHAIN_PAYOUT).toBe(1_000_000_000n);
    expect(payoutCapError('1000000000')).toBeNull();
    expect(payoutCapError('1000000001')).toMatch(/up to 1,000 USDC each/);
    expect(refusal(payoutCapError('1000000001')!, 'Base')).toMatch(/up to 1,000 USDC each/);
  });
});
