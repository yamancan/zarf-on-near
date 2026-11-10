import { describe, expect, it } from 'vitest';
import vectors from '../../../spec/vectors.json';
import {
  classifyDestination, claimState, deadlineText, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isImplicitAccount, isValidAccountId, loadAttempt, newAttemptId,
  decodeProof, encodeProof, parseCallback, parseLinkFragment, saveAttempt, clearAttempt,
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
    expect(deadlineText(at, at - 3_600_000, 'UTC')).toMatch(/1 hour left$/);
    expect(deadlineText(at, at - 60_000, 'UTC')).toMatch(/less than an hour left$/);
    expect(deadlineText(at, at + 1, 'UTC')).toBe('17 Nov 2026, 21:55 UTC');
  });
});
