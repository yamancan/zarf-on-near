import { describe, expect, it } from 'vitest';
import vectors from '../../spec/vectors.json';
import { canonicalizeEmail, claimLink, commitment, leaf, unhex } from '../src/claim';
import { campaignIdFrom, CreateError, stubCreator, testnetCreator, type CampaignCreator } from '../src/creator';
import { handleFaucet, type FaucetDeps } from '../src/faucet';
import { takeQuota, type KvLike } from '../src/limits';
import { base58Encode, encodeTx, parseNearKey } from '../src/near';

const memKv = (): KvLike & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return { m, get: async (k) => m.get(k) ?? null, put: async (k, v) => void m.set(k, v) };
};

describe('spec/vectors.json', () => {
  const all = [...vectors.campaigns.main.recipients, ...vectors.campaigns.single.recipients];
  it.each(all)('canonical email, commitment and leaf for $canonical_email', async (r) => {
    const c = canonicalizeEmail(r.email);
    expect(c).toBe(r.canonical_email);
    expect(await commitment(unhex(r.salt, 32), c!)).toBe(r.commitment);
    expect(await leaf(r.commitment, r.amount)).toBe(r.leaf);
  });
  it('a one-leaf tree: root = leaf', async () => {
    const r = vectors.campaigns.single.recipients[0];
    expect(await leaf(r.commitment, r.amount)).toBe(vectors.campaigns.single.merkle_root);
  });
  it.each(vectors.rejected_emails)('refuses %j', (e) => expect(canonicalizeEmail(e)).toBeNull());
});

it('claim link format', () => {
  expect(claimLink('https://c.example/', '8', 'ab'.repeat(32), '90'.repeat(32))).toBe(
    `https://c.example/claim/8/${'ab'.repeat(32)}#s=${'90'.repeat(32)}`,
  );
});

describe('takeQuota', () => {
  const limits = { perIpPerDay: 2, perEmailPerDay: 1, dailyCap: 3 };
  const now = Date.UTC(2026, 10, 11, 12);
  it('limits per email, per IP and per day, and resets the next UTC day', async () => {
    const kv = memKv();
    const t = (ip: string, e: string, ms = now) => takeQuota(kv, 'k', limits, ip, e, ms).then((r) => (r.ok ? 'ok' : r.code));
    expect(await t('1.1.1.1', 'a@x.io')).toBe('ok');
    expect(await t('2.2.2.2', 'a@x.io')).toBe('RATE_LIMITED_EMAIL');
    expect(await t('1.1.1.1', 'b@x.io')).toBe('ok');
    expect(await t('1.1.1.1', 'c@x.io')).toBe('RATE_LIMITED_IP');
    expect(await t('3.3.3.3', 'd@x.io')).toBe('ok');
    expect(await t('4.4.4.4', 'e@x.io')).toBe('DAILY_CAP_REACHED');
    expect(await t('4.4.4.4', 'e@x.io', now + 86_400_000)).toBe('ok');
  });
  it('a refused request spends nothing', async () => {
    const kv = memKv();
    await takeQuota(kv, 'k', limits, 'ip', 'a@x.io', now);
    const before = new Map(kv.m);
    await takeQuota(kv, 'k', limits, 'ip2', 'a@x.io', now);
    expect(kv.m).toEqual(before);
  });
  it('never stores an email or IP in the clear', async () => {
    const kv = memKv();
    await takeQuota(kv, 'k', limits, '203.0.113.9', 'alice@example.com', now);
    const dump = JSON.stringify([...kv.m]);
    expect(dump).not.toContain('alice');
    expect(dump).not.toContain('203.0.113.9');
  });
});

describe('handleFaucet', () => {
  const solo = vectors.campaigns.single.recipients[0];
  const deps = (over: Partial<FaucetDeps> = {}): FaucetDeps => ({
    claimHost: 'https://claim.example', amount: solo.amount, lifetimeS: 3600, limitKey: 'k', kv: memKv(),
    limits: { perIpPerDay: 5, perEmailPerDay: 1, dailyCap: 10 }, creator: stubCreator(8n), nowMs: 1_794_484_800_000,
    randomSalt: () => unhex(solo.salt, 32), ...over,
  });

  it('returns the spec link for the vector recipient and publishes the leaf list', async () => {
    const d = deps();
    const r = await handleFaucet({ email: '  Solo@Example.com ' }, 'ip', d);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      claim_url: `https://claim.example/claim/8/${solo.commitment}#s=${solo.salt}`,
      campaign_id: '8', commitment: solo.commitment, amount: solo.amount, deadline_ns: '1794488400000000000', stub: true,
    });
    expect(JSON.parse((await d.kv.get('leaves:8'))!)).toEqual({
      campaign_id: '8', merkle_root: vectors.campaigns.single.merkle_root, leaves: [{ commitment: solo.commitment, amount: solo.amount }],
    });
  });

  it('uses a fresh salt per request', async () => {
    const d = deps({ randomSalt: undefined, limits: { perIpPerDay: 5, perEmailPerDay: 5, dailyCap: 10 } });
    const a = await handleFaucet({ email: 'a@x.io' }, 'ip', d);
    const b = await handleFaucet({ email: 'a@x.io' }, 'ip', d);
    expect(a.body.commitment).not.toBe(b.body.commitment);
  });

  it.each([null, {}, { email: 1 }, { email: 'no-at-sign' }, { email: 'a@b' }, { email: 'josé@example.com' }, { email: `${'a'.repeat(250)}@x.io` }])(
    'refuses %j as BAD_EMAIL without spending quota',
    async (input) => {
      const d = deps();
      expect((await handleFaucet(input, 'ip', d)).body).toEqual({ error: 'BAD_EMAIL' });
      expect((d.kv as ReturnType<typeof memKv>).m.size).toBe(0);
    },
  );

  it('429s on the second request for the same email', async () => {
    const d = deps();
    await handleFaucet({ email: 'a@x.io' }, 'ip', d);
    expect(await handleFaucet({ email: 'A@x.io' }, 'ip2', d)).toEqual({ status: 429, body: { error: 'RATE_LIMITED_EMAIL' } });
  });

  it('503s with the creator code, and on unknown errors', async () => {
    const failing = (e: unknown): CampaignCreator => ({ live: true, create: async () => { throw e; } });
    expect(await handleFaucet({ email: 'a@x.io' }, 'ip', deps({ creator: failing(new CreateError('FAUCET_NOT_PREPAID')) })))
      .toEqual({ status: 503, body: { error: 'FAUCET_NOT_PREPAID' } });
    expect(await handleFaucet({ email: 'a@x.io' }, 'ip', deps({ creator: failing(new Error('rpc down')) })))
      .toEqual({ status: 503, body: { error: 'CREATE_FAILED' } });
  });
});

describe('testnet creator (stubbed RPC; nothing is sent)', () => {
  const unhexAny = (s: string) => Uint8Array.from(s.match(/../g)!, (x) => parseInt(x, 16));
  const SECRET = `ed25519:${base58Encode(unhexAny(vectors.keys.signer_seed + vectors.keys.signer))}`;
  const event = (data: object) => `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event: 'campaign_created', data: [data] })}`;
  const req = { merkleRoot: 'aa'.repeat(32), amount: '1000000', deadlineNs: '1' };

  it('sends one ft_transfer_call with 1 yocto and the 1-leaf msg, and reads campaign_id from the event', async () => {
    const calls: [string, any][] = [];
    const rpc = {
      async call<T>(method: string, params: any): Promise<T> {
        calls.push([method, params]);
        if (method === 'query') return { nonce: 41, block_hash: base58Encode(new Uint8Array(32).fill(7)) } as T;
        return { receipts_outcome: [{ outcome: { executor_id: 'esc.testnet', logs: [event({ campaign_id: '12', merkle_root: req.merkleRoot, amount: '1000000' })] } }] } as T;
      },
    };
    const c = testnetCreator({ rpc, senderId: 'faucet.testnet', key: await parseNearKey(SECRET), tokenId: 'usdc.testnet', contractId: 'esc.testnet' });
    const out = await c.create(req);
    expect(out.campaignId).toBe('12');
    expect(out.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    const signed = Uint8Array.from(atob(calls[1][1].signed_tx_base64), (ch) => ch.charCodeAt(0));
    const text = new TextDecoder().decode(signed);
    expect(text).toContain('ft_transfer_call');
    expect(text).toContain('"leaf_count\\":1');
    expect(text).toContain('"policy\\":\\"owner\\"');
    // deposit: the last 16 bytes of the transaction body are u128 LE = 1, right before the signature (1 + 64 bytes)
    expect(Array.from(signed.subarray(signed.length - 65 - 16, signed.length - 65))).toEqual([1, ...new Array(15).fill(0)]);
  });

  it('maps an E128 failure to FAUCET_NOT_PREPAID and a missing event to CREATE_FAILED', async () => {
    const mk = (outcome: object) => ({
      async call<T>(method: string): Promise<T> {
        return (method === 'query' ? { nonce: 1, block_hash: base58Encode(new Uint8Array(32)) } : outcome) as T;
      },
    });
    const key = await parseNearKey(SECRET);
    const base = { senderId: 'f.testnet', key, tokenId: 'u.testnet', contractId: 'esc.testnet' };
    const e128 = { receipts_outcome: [{ outcome: { executor_id: 'esc.testnet', status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: E128_INSUFFICIENT_STORAGE' } } } } } } }] };
    await expect(testnetCreator({ ...base, rpc: mk(e128) }).create(req)).rejects.toMatchObject({ code: 'FAUCET_NOT_PREPAID' });
    await expect(testnetCreator({ ...base, rpc: mk({ receipts_outcome: [] }) }).create(req)).rejects.toMatchObject({ code: 'CREATE_FAILED' });
  });

  it('ignores a campaign_created event with another root or from another contract', () => {
    const ev = event({ campaign_id: '3', merkle_root: 'bb'.repeat(32), amount: '1000000' });
    expect(campaignIdFrom({ receipts_outcome: [{ outcome: { executor_id: 'esc.testnet', logs: [ev] } }] }, 'esc.testnet', { merkleRoot: req.merkleRoot, amount: '1000000' })).toBeNull();
    const ok = event({ campaign_id: '3', merkle_root: req.merkleRoot, amount: '1000000' });
    expect(campaignIdFrom({ receipts_outcome: [{ outcome: { executor_id: 'evil.testnet', logs: [ok] } }] }, 'esc.testnet', { merkleRoot: req.merkleRoot, amount: '1000000' })).toBeNull();
  });

  it('encodes the deposit as u128 LE at the end of the FunctionCall', () => {
    const tx = encodeTx({ signerId: 'a', publicKey: new Uint8Array(32), nonce: 1n, receiverId: 'b', blockHash: new Uint8Array(32), methodName: 'm', args: new Uint8Array(), gas: 1n, deposit: 258n });
    expect(Array.from(tx.subarray(tx.length - 16))).toEqual([2, 1, ...new Array(14).fill(0)]);
  });
});
