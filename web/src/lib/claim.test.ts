import { describe, expect, it } from 'vitest';
import vectors from '../../../spec/vectors.json';
import {
  claimState, destinationNonce, googleAuthUrl, isCampaignId, isHex32, isImplicitAccount, isValidAccountId, loadAttempt, newAttemptId,
  parseCallback, saltFromFragment, saveAttempt, clearAttempt,
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
  it('reads the salt from the fragment', () => {
    expect(saltFromFragment(`#s=${salt}`)).toBe(salt);
    expect(saltFromFragment(`s=${salt}`)).toBe(salt);
  });
  it.each(['', '#', '#s=', '#s=abc', `#s=${main.recipients[0].commitment.toUpperCase()}`, `#x=${salt}`])('rejects fragment %j', (h) =>
    expect(saltFromFragment(h)).toBeNull());
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
    const a = { campaign: '7', commitment: 'c', salt: 's', destination: 'alice.testnet', attemptId: 'x' };
    saveAttempt(a, s);
    expect(loadAttempt(s)).toEqual(a);
    clearAttempt(s);
    expect(loadAttempt(s)).toBeNull();
    saveAttempt(a, s);
    s.setItem('zarf-near:attempt', '{');
    expect(loadAttempt(s)).toBeNull();
  });
});
