import { describe, expect, it } from 'vitest';
import wranglerJsonc from '../../wrangler.jsonc?raw';
import vectors from '../../../spec/vectors.json';
import {
  classifyDestination, nearAccountReady, missingAccountLine, typedBefore, claimStartedHere, holdPage, CLAIMED_NO_RECORD, INCOMPLETE_LINE, EXPLORER_LABEL, claimState, deadlineText, timeLeft, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isImplicitAccount, isValidAccountId, loadAttempt, newAttemptId,
  decodeProof, encodeProof, parseCallback, parseLinkFragment, saveAttempt, clearAttempt, saveReceipt, loadReceipt, settleReceipt, claimedAt, middle, twoDecimals, shownAmount, confirmRemembered, RECEIPT_TTL_MS,
} from './claim';

const main = vectors.campaigns.main;

describe('spec/vectors.json (v2.1)', () => {
  it('is not empty', () => {
    expect(vectors.claims.valid.length).toBeGreaterThanOrEqual(4);
    expect(vectors.claims.invalid.length).toBeGreaterThanOrEqual(10);
    expect(main.recipients.length).toBeGreaterThanOrEqual(1);
  });
  it.each(vectors.claims.valid)('nonce matches $name', async (c) => {
    expect(isValidAccountId(c.call_args.destination)).toBe(true);
    expect(await destinationNonce(c.call_args.destination)).toBe(c.nonce);
  });
});

describe('isValidAccountId', () => {
  it.each(['alice.testnet', 'a1', 'my_wallet-2.near', 'a'.repeat(64), 'sub.alice.testnet', '0x' + 'ab'.repeat(20)])(
    'accepts %s', (id) => expect(isValidAccountId(id)).toBe(true));
  it.each(['a', 'a'.repeat(65), 'Alice.testnet', 'alice..testnet', '.alice', 'alice.', 'alice-', '-alice', 'al ice', 'a__b', 'alice@near', ''])(
    'rejects %j', (id) => expect(isValidAccountId(id)).toBe(false));
});

describe('claim link', () => {
  const salt = main.recipients[0].salt;
  const valid = vectors.claims.valid;
  const linksOf = Object.entries(vectors.links).flatMap(([name, ls]) => ls.map((l) => ({ name, l })));
  it.each(linksOf)('$name: parses $l into the spec claim args', ({ name, l }) => {
    const [path, hash] = l.split('#');
    const commitment = path.split('/')[3];
    const c = valid.find((v) => v.campaign === name && v.call_args.commitment === commitment);
    const r = vectors.campaigns[name as keyof typeof vectors.campaigns].recipients.find((x) => x.commitment === commitment)!;
    const got = parseLinkFragment(`#${hash}`)!;
    expect(got.salt).toBe(r.salt);
    expect(got.amount).toBe(r.amount);
    if (c) expect(got.proof).toEqual(c.call_args.proof);
    expect(encodeProof(got.proof)).toBe(new URLSearchParams(hash).get('p'));
  });
  it('an empty proof is an empty p=', () => {
    expect(encodeProof([])).toBe('');
    expect(decodeProof('')).toEqual([]);
  });
  const ok = `s=${salt}&a=1&p=`;
  it.each([
    '', '#', `#s=${salt}`, `#s=${salt}&a=1`, `#s=${'AB'.repeat(32)}&a=1&p=`, `#s=abc&a=1&p=`, '#a=1&p=',
    `#s=${salt}&a=0&p=`, `#s=${salt}&a=01&p=`, `#s=${salt}&a=-1&p=`, `#s=${salt}&a=1.5&p=`,
    `#s=${salt}&a=${1n << 128n}&p=`, `#s=${salt}&a=1&p=AAAA`, `#s=${salt}&a=1&p=${'A'.repeat(43)}=`,
    `#s=${salt}&a=1&p=${encodeProof(Array(21).fill('ab'.repeat(32)))}`,
  ])('rejects fragment %j', (h) => expect(parseLinkFragment(h)).toBeNull());
  it('accepts the largest u128 and 20 siblings', () => {
    const proof = Array(20).fill('ab'.repeat(32));
    expect(parseLinkFragment(`#${ok}`)).toEqual({ salt, amount: '1', proof: [] });
    expect(parseLinkFragment(`#s=${salt}&a=${(1n << 128n) - 1n}&p=${encodeProof(proof)}`)?.proof).toEqual(proof);
  });
  it('rejects a non-canonical base64url proof (trailing bits set)', () => {
    const p = encodeProof(['ab'.repeat(32)]); // 43 chars: the last one carries 2 unused bits
    const flipped = p.slice(0, -1) + String.fromCharCode(p.charCodeAt(42) + 1);
    expect(decodeProof(flipped)).toBeNull();
  });
  it('recognises implicit accounts', () => {
    expect(isImplicitAccount(vectors.keys.signer)).toBe(true);
    expect(isImplicitAccount('alice.testnet')).toBe(false);
  });
  it('validates campaign id and commitment', () => {
    expect(isCampaignId('7')).toBe(true);
    expect(isCampaignId('18446744073709551615')).toBe(true);
    expect(isCampaignId('18446744073709551616')).toBe(false);
    expect(isCampaignId('07')).toBe(false);
    expect(isCampaignId('-1')).toBe(false);
    expect(isHex32(main.recipients[0].commitment)).toBe(true);
    expect(isHex32('zz'.repeat(32))).toBe(false);
  });
});

describe('Google redirect', () => {
  it('builds the OIDC implicit request with our nonce and state', () => {
    const url = new URL(googleAuthUrl({ clientId: 'cid', redirectUri: 'http://localhost:5173/auth/google', nonce: 'n'.repeat(64), state: '7/abc' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'cid', redirect_uri: 'http://localhost:5173/auth/google', response_type: 'id_token',
      scope: 'openid email', nonce: 'n'.repeat(64), state: '7/abc', prompt: 'select_account',
    });
  });
  it('parses the callback fragment', () => {
    expect(parseCallback('#state=7%2Fabc&id_token=a.b.c&authuser=0')).toEqual({ idToken: 'a.b.c', state: '7/abc' });
    expect(parseCallback('#error=access_denied&state=7%2Fabc')).toEqual({ error: 'access_denied' });
    expect(parseCallback('')).toEqual({ error: 'missing_token' });
  });
  it('state carries a random per-attempt id', () => {
    const a = newAttemptId(), b = newAttemptId();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
    expect(claimState('7', 'c', a)).toBe(`7/c/${a}`);
  });
  it('state round-trips through URL encoding', () => {
    const s = claimState('7', main.recipients[0].commitment, newAttemptId());
    expect(parseCallback(`#id_token=t&${new URLSearchParams({ state: s })}`)).toEqual({ idToken: 't', state: s });
  });
});

describe('attempt storage', () => {
  const mem = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } as Storage;
  };
  it('round-trips and tolerates garbage', () => {
    const s = mem();
    expect(loadAttempt(s)).toBeNull();
    const a = { campaign: '7', commitment: 'c', salt: 's', amount: '1', proof: [], destination: 'alice.testnet', attemptId: 'x' };
    saveAttempt(a, s);
    expect(loadAttempt(s)).toEqual(a);
    clearAttempt(s);
    expect(loadAttempt(s)).toBeNull();
    saveAttempt(a, s);
    s.setItem('zarf-near:attempt', '{');
    expect(loadAttempt(s)).toBeNull();
  });
});

describe('classifyDestination', () => {
  const stellarG = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  it('names and implicit ids, trimmed and lower-cased', () => {
    expect(classifyDestination('  Alice.Testnet ')).toEqual({ kind: 'named', id: 'alice.testnet' });
    expect(classifyDestination('AB'.repeat(32))).toEqual({ kind: 'implicit', id: 'ab'.repeat(32) });
    expect(classifyDestination(' ')).toEqual({ kind: 'empty' });
  });
  it.each([
    [stellarG, /Stellar/], [stellarG.toLowerCase(), /Stellar/], ['M' + 'A'.repeat(68), /Stellar/],
    ['0x' + 'ab'.repeat(20), /Ethereum/], ['0X' + 'AB'.repeat(20), /Ethereum/],
    ['alice..testnet', /not a valid/], ['a', /not a valid/],
  ])('refuses %s', (input, why) => {
    const d = classifyDestination(input);
    expect(d.kind).toBe('wrong');
    expect((d as { reason: string }).reason).toMatch(why);
  });
  it('a lower-cased Stellar address would pass the NEAR format check, so the raw input is checked first', () => {
    expect(isValidAccountId(stellarG.toLowerCase())).toBe(true);
  });
});

describe('deadlineText', () => {
  const at = Date.UTC(2026, 10, 17, 21, 55);
  it('absolute in the given zone, with the time left', () => {
    expect(deadlineText(at, at - 6.5 * 86_400_000, 'UTC')).toBe('17 Nov 2026, 21:55 UTC, 6 days left');
    expect(deadlineText(at, at - 5 * 3_600_000, 'UTC')).toBe('17 Nov 2026, 21:55 UTC, 5 hours left');
  });
  it('a deadline picked as one week reads 7 days left a moment later, and never overstates by more than an hour', () => {
    const now = Date.UTC(2026, 10, 12);
    expect(timeLeft(now + 7 * 86_400_000 - 5_000, now)).toBe('7 days left');
    expect(timeLeft(now + 30 * 86_400_000 - 60_000, now)).toBe('30 days left');
    expect(timeLeft(now + 7 * 86_400_000 - 3_600_000, now)).toBe('7 days left');
    expect(timeLeft(now + 7 * 86_400_000 - 3_600_001, now)).toBe('6 days left');
    expect(timeLeft(now + 6.5 * 86_400_000, now)).toBe('6 days left');
    expect(deadlineText(at, at - 3_600_000, 'UTC')).toMatch(/1 hour left$/);
    expect(deadlineText(at, at - 60_000, 'UTC')).toMatch(/less than an hour left$/);
    expect(deadlineText(at, at + 1, 'UTC')).toBe('17 Nov 2026, 21:55 UTC');
  });
});

describe('receipt record (reload or reopened link after a paid claim)', () => {
  const mem = (): Storage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) } as Storage;
  };
  const K = 'zarf-near-1112.testnet';
  const r = { amount: '10000000', destination: 'alice.testnet', txHash: '6zgh2u9DqHHiXzdy9ouTP7oGky2T4nugqzqt9wJZwNFm' };
  it('is kept per contract and claim, and survives garbage', () => {
    const s = mem();
    expect(loadReceipt(K, '7', 'c', s)).toBeNull();
    saveReceipt(K, '7', 'c', r, s);
    expect(loadReceipt(K, '7', 'c', s)).toMatchObject(r);
    expect(loadReceipt(K, '7', 'd', s)).toBeNull();
    s.setItem(`zarf-near:receipt:${K}/7/c`, '{');
    expect(loadReceipt(K, '7', 'c', s)).toBeNull();
  });
  it('is never read back on another contract served from the same host (security review m1)', () => {
    const s = mem();
    saveReceipt('old-contract.testnet', '7', 'c', r, s);
    expect(loadReceipt(K, '7', 'c', s)).toBeNull();
    s.setItem('zarf-near:receipt:7/c', JSON.stringify(r)); // the round-1 key had no contract id
    expect(loadReceipt(K, '7', 'c', s)).toBeNull();
  });
  it('refuses a record whose tx hash or amount is malformed (it feeds the explorer link)', () => {
    const s = mem();
    saveReceipt(K, '7', 'c', { ...r, txHash: 'javascript:alert(1)' }, s);
    expect(loadReceipt(K, '7', 'c', s)).toBeNull();
    saveReceipt(K, '7', 'c', { ...r, amount: '-1' }, s);
    expect(loadReceipt(K, '7', 'c', s)).toBeNull();
  });
  it('never throws when storage is blocked', () => {
    const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } } as unknown as Storage;
    expect(() => saveReceipt(K, '7', 'c', r, blocked)).not.toThrow();
    expect(loadReceipt(K, '7', 'c', blocked)).toBeNull();
  });
  it('remembers a cross-chain claim as in transit until the bridge reports, and only success as paid', () => {
    const s = mem();
    const chain = { ...r, destination: '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed', chainName: 'Base' };
    saveReceipt(K, '7', 'c', chain, s); // no outcome recorded: in transit, never "paid out"
    expect(loadReceipt(K, '7', 'c', s)!.bridge).toBe('in-transit');
    saveReceipt(K, '7', 'c', { ...chain, bridge: 'bogus' as never }, s);
    expect(loadReceipt(K, '7', 'c', s)!.bridge).toBe('in-transit');
    settleReceipt(K, '7', 'c', 'failed', undefined, s);
    expect(loadReceipt(K, '7', 'c', s)!.bridge).toBe('failed');
    settleReceipt(K, '7', 'c', 'paid', '9.99558', s);
    expect(loadReceipt(K, '7', 'c', s)).toMatchObject({ bridge: 'paid', amountOut: '9.99558' });
    settleReceipt(K, '7', 'c', 'refunded', '1', s);
    expect(loadReceipt(K, '7', 'c', s)).toMatchObject({ bridge: 'refunded' });
  });
  it('settling needs an existing cross-chain record; a NEAR record never gets a bridge state', () => {
    const s = mem();
    settleReceipt(K, '7', 'c', 'paid', '1', s);
    expect(loadReceipt(K, '7', 'c', s)).toBeNull();
    saveReceipt(K, '7', 'c', r, s);
    settleReceipt(K, '7', 'c', 'failed', undefined, s);
    expect(loadReceipt(K, '7', 'c', s)!.bridge).toBeUndefined();
  });
  it('drops a malformed display amount instead of showing it', () => {
    const s = mem();
    saveReceipt(K, '7', 'c', { ...r, chainName: 'Base', bridge: 'paid', amountOut: '<b>9</b>' }, s);
    expect(loadReceipt(K, '7', 'c', s)!.amountOut).toBeUndefined();
  });
  it('expires 30 days after it was saved, and is cleared when read after that (security nit)', () => {
    const s = mem(), t = Date.UTC(2026, 10, 12);
    saveReceipt(K, '7', 'c', r, s, t);
    saveReceipt(K, '7', 'c', loadReceipt(K, '7', 'c', s, t)!, s, t + RECEIPT_TTL_MS - 2); // a later save keeps the first date
    expect(loadReceipt(K, '7', 'c', s, t + RECEIPT_TTL_MS - 1)).toMatchObject({ ...r, savedAt: t });
    expect(loadReceipt(K, '7', 'c', s, t + RECEIPT_TTL_MS)).toBeNull();
    expect(s.getItem(`zarf-near:receipt:${K}/7/c`)).toBeNull();
    s.setItem(`zarf-near:receipt:${K}/7/c`, JSON.stringify(r)); // undated (round 2 records): cleared too
    expect(loadReceipt(K, '7', 'c', s)).toBeNull();
    expect(s.getItem(`zarf-near:receipt:${K}/7/c`)).toBeNull();
  });
  it('keeps a valid deposit address and drops a malformed one', () => {
    const s = mem();
    saveReceipt(K, '7', 'c', { ...r, chainName: 'Base', depositAddress: 'd'.repeat(64), refundTo: 'sender.near' }, s);
    expect(loadReceipt(K, '7', 'c', s)).toMatchObject({ depositAddress: 'd'.repeat(64), refundTo: 'sender.near' });
    saveReceipt(K, '7', 'c', { ...r, chainName: 'Base', depositAddress: 'javascript:x' }, s);
    expect(loadReceipt(K, '7', 'c', s)!.depositAddress).toBeUndefined();
  });
  it('shows one amount: the bridge payout once paid, otherwise the link amount (round 3 A4)', () => {
    expect(shownAmount({ chainName: 'Base', bridge: 'paid', amountOut: '9.99558' }, '10', 'USDC')).toEqual({ value: '9.99', unit: 'USDC' });
    for (const bridge of ['in-transit', 'failed', 'refunded'] as const) expect(shownAmount({ chainName: 'Base', bridge, amountOut: '9.99558' }, '10', 'USDC')).toEqual({ value: '10', unit: 'USDC' });
    expect(shownAmount({ chainName: 'Base', bridge: 'paid' }, '10', 'USDC')).toEqual({ value: '10', unit: 'USDC' });
    expect(shownAmount({}, '10', 'test USDC')).toEqual({ value: '10', unit: 'test USDC' });
  });
  it('confirmRemembered shows a record only when the chain says claimed; a failed read throws (receipt page verifyRemembered)', async () => {
    const rec = { ...r, savedAt: 1 };
    expect(await confirmRemembered(rec, async () => 'claimed')).toBe(rec);
    expect(await confirmRemembered(rec, async () => 'unclaimed')).toBeNull();
    expect(await confirmRemembered(rec, async () => 'pending')).toBeNull();
    let read = false;
    expect(await confirmRemembered(null, async () => { read = true; return 'claimed'; })).toBeNull();
    expect(read).toBe(false);
    await expect(confirmRemembered(rec, async () => { throw new Error('rpc'); })).rejects.toThrow('rpc');
  });
  it('dates a remembered claim in en-GB', () => {
    expect(claimedAt(Date.UTC(2026, 10, 12, 14, 2), 'UTC')).toBe('12 Nov 2026, 14:02');
  });
});

describe('display helpers', () => {
  it('middle-truncates long addresses only', () => {
    expect(middle('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe('0x5aAe…1BeAed');
    expect(middle('alice.testnet')).toBe('alice.testnet');
  });
  it('cuts to two decimals without rounding up', () => {
    expect(twoDecimals('9.99558')).toBe('9.99');
    expect(twoDecimals('10')).toBe('10');
    expect(twoDecimals('2.5')).toBe('2.5');
    expect(twoDecimals('9.009')).toBe('9');
    expect(twoDecimals('7.001')).toBe('7');
  });
});


describe('a receipt without a hash (the relayer answer was lost, the chain said claimed)', () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } as unknown as Storage; };
  it('is kept with its cross-chain fields, so a reopened link can re-poll the bridge', () => {
    const s = mem();
    const r = { amount: '10000000', txHash: '', destination: '0x' + 'ab'.repeat(20), chainName: 'Base', bridge: 'in-transit' as const, depositAddress: 'd'.repeat(64), refundTo: 'sender.near' };
    saveReceipt('c', '2', 'ab', r, s, 1000);
    expect(loadReceipt('c', '2', 'ab', s, 2000)).toMatchObject({ txHash: '', depositAddress: 'd'.repeat(64), refundTo: 'sender.near', chainName: 'Base' });
  });
  it('still refuses a hash that is present but malformed', () => {
    const s = mem();
    saveReceipt('c', '2', 'ab', { amount: '1', txHash: 'not-base58!', destination: 'a.testnet' }, s, 1000);
    expect(loadReceipt('c', '2', 'ab', s, 2000)).toBeNull();
  });
});

describe('accountExplorerUrl (receipt: See it in your wallet)', async () => {
  const { accountExplorerUrl } = await import('./network');
  it('maps the nearblocks tx base to the account page; nothing without one', () => {
    expect(accountExplorerUrl('https://testnet.nearblocks.io/txns/', 'alice.testnet')).toBe('https://testnet.nearblocks.io/address/alice.testnet');
    expect(accountExplorerUrl('https://nearblocks.io/txns/', 'a'.repeat(64))).toBe(`https://nearblocks.io/address/${'a'.repeat(64)}`);
    expect(accountExplorerUrl('', 'alice.testnet')).toBe('');
    expect(accountExplorerUrl('https://other.example/tx?h=', 'alice.testnet')).toBe('');
  });
});

describe('wrong-address protection (T-002)', () => {
  const contracts = { escrow: 'zarf-near-1112.testnet', token: '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af' };
  it('refuses the escrow and the token contract, in any case', () => {
    expect(classifyDestination(' Zarf-Near-1112.testnet', contracts)).toEqual({ kind: 'wrong', reason: expect.stringMatching(/Zarf contract itself/) });
    expect(classifyDestination(contracts.token.toUpperCase(), contracts)).toEqual({ kind: 'wrong', reason: expect.stringMatching(/USDC token contract/) });
    expect(classifyDestination('alice.testnet', contracts)).toEqual({ kind: 'named', id: 'alice.testnet' });
  });
  const named = classifyDestination('alice.testnet');
  const implicit = classifyDestination('ab'.repeat(32));
  it('goes to Google only after "Is this your account?" for this exact, existing account', () => {
    const found = { id: 'alice.testnet', state: 'found' as const };
    expect(nearAccountReady(named, found, false, '')).toBe(false);
    expect(nearAccountReady(named, found, false, 'alice.testnet')).toBe(true);
    expect(nearAccountReady(named, found, false, 'alice2.testnet')).toBe(false); // confirmed another id, then edited
    expect(nearAccountReady(named, { id: 'alice.testnet', state: 'checking' }, false, 'alice.testnet')).toBe(false);
    expect(nearAccountReady(named, { id: 'alice.testnet', state: 'missing' }, true, 'alice.testnet')).toBe(false); // a named typo is never paid
    expect(nearAccountReady(named, { id: 'alice.testnet', state: 'error' }, false, 'alice.testnet')).toBe(false);
    expect(nearAccountReady(named, { id: 'bob.testnet', state: 'found' }, false, 'alice.testnet')).toBe(false); // stale check
  });
  it('a 64-hex id not on chain needs the key-holder warning acknowledged, then the confirm', () => {
    const missing = { id: 'ab'.repeat(32), state: 'missing' as const };
    expect(nearAccountReady(implicit, missing, false, 'ab'.repeat(32))).toBe(false);
    expect(nearAccountReady(implicit, missing, true, '')).toBe(false);
    expect(nearAccountReady(implicit, missing, true, 'ab'.repeat(32))).toBe(true);
  });
  it('never for an empty or wrong field', () => {
    expect(nearAccountReady(classifyDestination(''), null, true, '')).toBe(false);
    expect(nearAccountReady(classifyDestination('0x' + 'ab'.repeat(20)), null, true, '')).toBe(false);
  });
});

describe('shared contracts and 0x ids (T-002 items 3-4)', () => {
  it.each(['intents.near', 'WRAP.NEAR', 'intents.testnet', 'wrap.testnet'])('refuses %s: a plain ft_transfer credits nobody', (id) => {
    expect(classifyDestination(id)).toEqual({ kind: 'wrong', reason: expect.stringMatching(/shared NEAR contract/) });
  });
  const eth = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
  it('a 0x id stays refused until enabled, then is lower-cased and treated like an implicit id', () => {
    expect(classifyDestination(eth).kind).toBe('wrong');
    expect(classifyDestination(` ${eth} `, { eth: true })).toEqual({ kind: 'implicit', id: eth.toLowerCase() });
    expect(classifyDestination(eth + 'a', { eth: true }).kind).toBe('wrong');
    const d = classifyDestination(eth, { eth: true });
    expect(nearAccountReady(d, { id: eth.toLowerCase(), state: 'found' }, false, eth.toLowerCase())).toBe(true);
  });
  it('a 0x id not on NEAR yet is refused with its own line, never the key-holder checkbox (T-016)', () => {
    const d = classifyDestination(eth, { eth: true });
    expect(nearAccountReady(d, { id: eth.toLowerCase(), state: 'missing' }, true, eth.toLowerCase())).toBe(false);
    expect(missingAccountLine(d)).toBe('This MetaMask address is new on NEAR: send it a little test NEAR first, then claim.');
    expect(missingAccountLine(classifyDestination('a'.repeat(64)))).toBe('Not on NEAR yet. Check every character.');
    expect(missingAccountLine(classifyDestination('alice.testnet'))).toBe('No such account. Check the spelling.');
  });
  it('0x destinations are on in the testnet build only', () => {
    const cfg = JSON.parse(wranglerJsonc.replace(/^\s*\/\/.*$/gm, ''));
    expect(cfg.env.testnet.vars.PUBLIC_ETH_ACCOUNTS).toBe('on');
    expect(cfg.env.mainnet.vars.PUBLIC_ETH_ACCOUNTS).toBe('');
    expect(cfg.vars.PUBLIC_ETH_ACCOUNTS).toBe('');
  });
});

describe('T-004: no false failures after Back, refresh or a lost link', () => {
  const att = { campaign: '7', commitment: 'c'.repeat(64), salt: 's', amount: '10', proof: [], destination: 'alice.testnet', attemptId: 'x' };
  it('Back after "Arrived": the remembered claim shows once the chain says claimed, else the incomplete card', async () => {
    const r = { amount: '500000', txHash: 'H'.repeat(44), at: 1, destination: 'alice.testnet' };
    expect(await confirmRemembered(r, async () => 'claimed')).toBe(r);
    expect(await confirmRemembered(r, async () => 'unclaimed')).toBeNull();
    expect(await confirmRemembered(null, async () => 'claimed')).toBeNull();
    await expect(confirmRemembered(r, async () => { throw new Error('rpc'); })).rejects.toThrow();
  });
  it('claimed with no record here: points at the wallet first, never implies theft', () => {
    expect(CLAIMED_NO_RECORD).toMatch(/^This link was claimed\. If you just tried, check your wallet\./);
    expect(CLAIMED_NO_RECORD).not.toMatch(/not you/);
  });
  it('a link opened without its secret part says how to recover it ("Open in browser" from a chat app)', () => {
    expect(INCOMPLETE_LINE).toMatch(/another app/);
    expect(INCOMPLETE_LINE).toMatch(/link from your message in Safari or Chrome/);
  });
  it('refresh mid-claim: leaving asks first while the claim runs, and stops asking after', () => {
    const t = new EventTarget();
    const release = holdPage(t);
    const e1 = new Event('beforeunload', { cancelable: true });
    t.dispatchEvent(e1);
    expect(e1.defaultPrevented).toBe(true);
    release();
    const e2 = new Event('beforeunload', { cancelable: true });
    t.dispatchEvent(e2);
    expect(e2.defaultPrevented).toBe(false);
  });
  it('a failed sign-in keeps the typed NEAR account for this link only, never a cross-chain deposit address', () => {
    expect(typedBefore(att, '7', 'c'.repeat(64))).toBe('alice.testnet');
    expect(typedBefore(att, '8', 'c'.repeat(64))).toBe('');
    expect(typedBefore(null, '7', 'c'.repeat(64))).toBe('');
    const chain = { ...att, destination: 'd'.repeat(64), intents: { chainName: 'Base', assetId: 'a', recipient: '0x1', refundTo: 's', requestDeadline: '', amountOutFormatted: '1' } };
    expect(typedBefore(chain, '7', 'c'.repeat(64))).toBe('');
  });
  it('a reload mid-claim is told apart from a receipt opened before any sign-in', () => {
    expect(claimStartedHere(att, '7', 'c'.repeat(64))).toBe(true);
    expect(claimStartedHere({ ...att, attemptId: '', destination: '' }, '7', 'c'.repeat(64))).toBe(false); // link opened, no sign-in yet
    expect(claimStartedHere(att, '7', 'd'.repeat(64))).toBe(false);
    expect(claimStartedHere(null, '7', 'c'.repeat(64))).toBe(false);
  });
  it('the receipt names the explorer, not a wallet', () => {
    expect(EXPLORER_LABEL).toBe('View on Explorer');
    expect(EXPLORER_LABEL).not.toMatch(/wallet/i);
  });
});
