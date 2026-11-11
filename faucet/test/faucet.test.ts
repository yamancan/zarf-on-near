import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';
import { canonicalizeEmail, claimLink, commitment, leaf, unhex } from '../src/claim';
import { campaignIdFrom, CreateError, stubCreator, testnetCreator, type CampaignCreator } from '../src/creator';
import { handleFaucet, type FaucetDeps } from '../src/faucet';
import { takeQuota, type KvLike } from '../src/limits';
import { base58Encode, encodeTx, parseNearKey } from '../src/near';
import { verifyTurnstile } from '../src/turnstile';

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
  const r = vectors.campaigns.single.recipients[0];
  expect(claimLink('https://c.example/', vectors.campaigns.single.campaign_id, r.commitment, r.salt, r.amount)).toBe(
    `https://c.example${vectors.links.single[0]}`,
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

  it('returns the spec link for the vector recipient', async () => {
    const r = await handleFaucet({ email: '  Solo@Example.com ' }, 'ip', deps());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      claim_url: `https://claim.example${vectors.links.single[0]}`,
      campaign_id: '8', commitment: solo.commitment, amount: solo.amount, deadline_ns: '1794488400000000000', stub: true,
    });
  });

  it('sends the one-leaf root to the creator', async () => {
    const seen: string[] = [];
    const creator: CampaignCreator = { live: false, create: async (q) => (seen.push(q.merkleRoot), { campaignId: '8', txHash: null }) };
    await handleFaucet({ email: 'solo@example.com' }, 'ip', deps({ creator }));
    expect(seen).toEqual([vectors.campaigns.single.merkle_root]);
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

describe('worker', () => {
  const unhexAny = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
  const KEY = `ed25519:${base58Encode(unhexAny(vectors.keys.signer_seed + vectors.keys.signer))}`;
  let rpcUrl = 0;
  // A fresh RPC URL per env, so the per-URL chain_id cache never leaks between tests.
  const fullEnv = (): Record<string, unknown> => ({
    NETWORK: 'testnet', CREATOR: 'testnet', CLAIM_HOST: 'https://claim.example', CONTRACT_ID: 'esc.testnet', TOKEN_ID: 'usdc.testnet',
    NEAR_RPC_URL: `https://rpc${rpcUrl++}.example`, FAUCET_SENDER_ID: 'faucet.testnet', AMOUNT: '1000000', LIFETIME_S: '600',
    PER_IP_PER_DAY: '3', PER_EMAIL_PER_DAY: '1', DAILY_CAP: '10', TURNSTILE_SITE_KEY: '0x4AAAAAAAsitekey',
    FAUCET_SENDER_KEY: KEY, LIMIT_KEY: 'k', TURNSTILE_SECRET: 'secret', FAUCET_KV: memKv(),
  });
  // Routes outbound fetches: NEAR `status`, and Turnstile siteverify.
  const net = (o: { chainId?: string; turnstile?: 'ok' | 'failed' | 'down'; tsHost?: string; float?: string; viewsDown?: boolean } = {}) => {
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u);
      seen.push(url);
      if (url.startsWith('https://challenges.cloudflare.com/')) {
        if (o.turnstile === 'down') throw new Error('network');
        return Response.json({ success: (o.turnstile ?? 'ok') === 'ok', hostname: o.tsHost ?? 'f.example' });
      }
      const body = JSON.parse(String(init?.body));
      if (body.method === 'status') seen.push(`${url}#status`);
      if (body.method === 'status') return Response.json({ jsonrpc: '2.0', id: 1, result: { chain_id: o.chainId ?? 'testnet' } });
      if (body.method === 'query' && body.params.request_type === 'call_function') {
        if (o.viewsDown) throw new Error('rpc down');
        const value = body.params.method_name === 'ft_balance_of' ? (o.float ?? '9000000') : '499100000000000000000000';
        return Response.json({ jsonrpc: '2.0', id: 1, result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
      }
      throw new Error(`unexpected ${body.method}`);
    });
    return seen;
  };
  afterEach(() => vi.unstubAllGlobals());
  const post = async (env: Record<string, unknown>, body: object = { email: 'not-an-email', turnstile: 't' }, o: { host?: string; type?: string } = {}) => {
    const { default: worker } = await import('../src/index');
    const res = await worker.fetch(new Request(`https://${o.host ?? 'f.example'}/faucet`, {
      method: 'POST', headers: { 'Content-Type': o.type ?? 'application/json' }, body: JSON.stringify(body),
    }), env as never);
    return { status: res.status, body: (await res.json()) as { error?: string } };
  };

  it('a full testnet env gets past every config check (BAD_EMAIL comes from the handler)', async () => {
    net();
    expect(await post(fullEnv())).toEqual({ status: 400, body: { error: 'BAD_EMAIL' } });
  });

  it.each(['NETWORK', 'CREATOR', 'CLAIM_HOST', 'CONTRACT_ID', 'TOKEN_ID', 'NEAR_RPC_URL', 'FAUCET_SENDER_ID', 'AMOUNT', 'LIFETIME_S',
    'PER_IP_PER_DAY', 'PER_EMAIL_PER_DAY', 'DAILY_CAP', 'TURNSTILE_SITE_KEY', 'FAUCET_SENDER_KEY', 'LIMIT_KEY', 'TURNSTILE_SECRET'])(
    'without %s it is FAUCET_MISCONFIGURED', async (k) => {
      net();
      const env = fullEnv();
      delete env[k];
      expect(await post(env)).toEqual({ status: 500, body: { error: 'FAUCET_MISCONFIGURED' } });
    });

  it.each<[string, Record<string, unknown>]>([
    ['mainnet NETWORK', { NETWORK: 'mainnet' }],
    ['a .near sender', { FAUCET_SENDER_ID: 'faucet.near' }],
    ['a .near contract', { CONTRACT_ID: 'esc.near' }],
    ['a non-https claim host', { CLAIM_HOST: 'http://claim.example' }],
    ['amount 0', { AMOUNT: '0' }],
    ['an unknown creator', { CREATOR: 'mainnet' }],
  ])('refuses %s', async (_n, over) => {
    net();
    expect((await post({ ...fullEnv(), ...over })).status).toBe(500);
  });

  it('refuses an RPC whose status reports another chain, and caches a good answer', async () => {
    net({ chainId: 'mainnet' });
    expect((await post(fullEnv())).body).toEqual({ error: 'FAUCET_MISCONFIGURED' });
    const seen = net();
    const env = fullEnv();
    await post(env);
    await post(env);
    expect(seen.filter((u) => u === `${env.NEAR_RPC_URL}#status`)).toHaveLength(1);
  });

  it('503s when the RPC status call fails, and retries next time', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('down'); });
    const env = fullEnv();
    expect((await post(env)).status).toBe(503);
    net();
    expect((await post(env)).status).toBe(400);
  });

  it('serves the stub creator only on localhost', async () => {
    net();
    const env = { ...fullEnv(), CREATOR: 'stub' };
    expect((await post(env)).status).toBe(500);
    expect((await post(env, { email: 'a@x.io', turnstile: 't' }, { host: 'localhost:8787' })).body).toMatchObject({ stub: true });
  });

  it('requires a JSON content type (no cross-site form posts)', async () => {
    net();
    expect(await post(fullEnv(), { email: 'a@x.io', turnstile: 't' }, { type: 'text/plain' })).toEqual({ status: 415, body: { error: 'UNSUPPORTED_MEDIA_TYPE' } });
  });

  it.each<['failed' | 'down', number, string]>([['failed', 403, 'TURNSTILE_FAILED'], ['down', 503, 'TURNSTILE_UNAVAILABLE']])(
    'turnstile %s → %i, and no quota is spent', async (t, status, error) => {
      net({ turnstile: t });
      const env = fullEnv();
      expect(await post(env, { email: 'a@x.io', turnstile: 'tok' })).toEqual({ status, body: { error } });
      expect((env.FAUCET_KV as ReturnType<typeof memKv>).m.size).toBe(0);
    });

  it.each<[string, Record<string, unknown>]>([
    ['the always-pass test secret', { TURNSTILE_SECRET: '1x0000000000000000000000000000000AA' }],
    ['a test site key', { TURNSTILE_SITE_KEY: '3x00000000000000000000FF'.replace('FF', 'AA') }],
  ])('refuses %s off localhost, allows it on localhost', async (_n, over) => {
    net({ tsHost: 'example.com' });
    const env = { ...fullEnv(), ...over, CREATOR: 'stub' };
    expect(await post(env, { email: 'a@x.io', turnstile: 't' })).toEqual({ status: 500, body: { error: 'FAUCET_MISCONFIGURED' } });
    expect((await post(env, { email: 'a@x.io', turnstile: 't' }, { host: '127.0.0.1:8787' })).body).toMatchObject({ stub: true });
  });

  it('refuses a token issued for another hostname', async () => {
    net({ tsHost: 'evil.example' });
    expect(await post(fullEnv(), { email: 'a@x.io', turnstile: 't' })).toEqual({ status: 403, body: { error: 'TURNSTILE_FAILED' } });
  });

  it('refuses with FAUCET_EMPTY below one link, before Turnstile and the quota', async () => {
    const seen = net({ float: '999999' }); // amount is 1000000 in this env
    const env = fullEnv();
    expect(await post(env, { email: 'a@x.io', turnstile: 't' })).toEqual({ status: 503, body: { error: 'FAUCET_EMPTY' } });
    expect(seen.some((u) => u.startsWith('https://challenges.cloudflare.com/'))).toBe(false);
    expect((env.FAUCET_KV as ReturnType<typeof memKv>).m.size).toBe(0);
    net({ float: '1000000' });
    expect((await post(fullEnv())).body).toEqual({ error: 'BAD_EMAIL' }); // exactly one link left is enough
  });

  it('503s when the float cannot be read', async () => {
    net({ viewsDown: true });
    expect(await post(fullEnv())).toEqual({ status: 503, body: { error: 'UPSTREAM_UNAVAILABLE' } });
  });

  it('/health shows the float and links left, and nothing secret', async () => {
    net({ float: '9000000' });
    const { default: worker } = await import('../src/index');
    const env: Record<string, unknown> = { ...fullEnv(), AMOUNT: '500000', LIMIT_KEY: 'limit-key-must-not-leak' };
    const res = await worker.fetch(new Request('https://f.example/health'), env as never);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, float: '9000000', links_left: '18', amount_per_link: '500000', sender_id: 'faucet.testnet', prepay_yocto: '499100000000000000000000' });
    const dump = JSON.stringify(body);
    for (const s of [env.FAUCET_SENDER_KEY, env.LIMIT_KEY, env.TURNSTILE_SECRET] as string[]) expect(dump).not.toContain(s);
    net({ viewsDown: true });
    expect((await worker.fetch(new Request('https://f.example/health'), env as never)).status).toBe(503);
  });

  it('a missing token never reaches siteverify', async () => {
    const seen = net();
    expect((await post(fullEnv(), { email: 'a@x.io' })).body).toEqual({ error: 'TURNSTILE_FAILED' });
    expect(seen.some((u) => u.startsWith('https://challenges.cloudflare.com/'))).toBe(false);
  });

  it('serves /try with the Turnstile widget and a CSP that allows only its origin', async () => {
    const { default: worker } = await import('../src/index');
    const page = await worker.fetch(new Request('https://f.example/try'), { TURNSTILE_SITE_KEY: '1x00000000000000000000AA"><x' } as never);
    const csp = page.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    const html = await page.text();
    expect(html).toContain('data-sitekey="1x00000000000000000000AAx"'); // attribute-escaped
    const linked = await (await worker.fetch(new Request('https://f.example/try'), { CLAIM_HOST: 'https://claim.example/' } as never)).text();
    expect(linked).toContain('href="https://claim.example/privacy"');
    expect(linked).toContain('href="https://claim.example/"');
    expect(linked).toContain('href="https://docs.near.org/getting-started/create-account"');
    const hostile = await (await worker.fetch(new Request('https://f.example/try'), { CLAIM_HOST: 'https://x.example/"><script>' } as never)).text();
    expect(hostile).not.toContain('x.example');
    expect(html).not.toMatch(/<script>(?!<)/);
    const js = await worker.fetch(new Request('https://f.example/try.js'), {} as never);
    const src = await js.text();
    expect(() => new Function(src)).not.toThrow();
  });
});

describe('verifyTurnstile', () => {
  it('posts secret, response and remoteip, and reads success', async () => {
    let form = '';
    const r = await verifyTurnstile('tok', 'sec', '203.0.113.9', null, async (_u, i) => ((form = String(i?.body)), Response.json({ success: true })));
    expect(r).toBe('ok');
    expect(new URLSearchParams(form).get('remoteip')).toBe('203.0.113.9');
    expect(new URLSearchParams(form).get('secret')).toBe('sec');
  });
  it.each([[{ success: false }, 'failed'], [{ success: 'true' }, 'failed'], [{}, 'failed']])('%j → %s', async (body, out) => {
    expect(await verifyTurnstile('tok', 's', 'ip', null, async () => Response.json(body))).toBe(out);
  });
  it('checks the hostname when one is given', async () => {
    const ok = async () => Response.json({ success: true, hostname: 'f.example' });
    expect(await verifyTurnstile('tok', 's', 'ip', 'f.example', ok)).toBe('ok');
    expect(await verifyTurnstile('tok', 's', 'ip', 'other.example', ok)).toBe('failed');
  });
  it('HTTP 500 and a thrown fetch are unavailable', async () => {
    expect(await verifyTurnstile('tok', 's', 'ip', null, async () => new Response('', { status: 500 }))).toBe('unavailable');
    expect(await verifyTurnstile('tok', 's', 'ip', null, async () => { throw new Error('x'); })).toBe('unavailable');
  });
});

describe('review m4', () => {
  const unhexAny = (h: string) => Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
  it('parseNearKey rejects a public half from another key', async () => {
    await expect(parseNearKey(`ed25519:${base58Encode(unhexAny(vectors.keys.signer_seed + vectors.keys.rogue_signer))}`)).rejects.toThrow(/public half/);
  });
  const ev = (o: object) => `EVENT_JSON:${JSON.stringify({ standard: 'zarf-near', version: '1.0.0', event: 'campaign_created', data: [{ campaign_id: '3', merkle_root: 'aa'.repeat(32), amount: '1000000', ...o }] })}`;
  const out = (log: string) => ({ receipts_outcome: [{ outcome: { executor_id: 'esc.testnet', logs: [log] } }] });
  const want = { merkleRoot: 'aa'.repeat(32), amount: '1000000' };
  it('campaignIdFrom checks the amount', () => {
    expect(campaignIdFrom(out(ev({})), 'esc.testnet', want)).toBe('3');
    expect(campaignIdFrom(out(ev({ amount: '999999' })), 'esc.testnet', want)).toBeNull();
  });
  it('campaignIdFrom checks the standard and the event name', () => {
    expect(campaignIdFrom(out(ev({}).replace('"zarf-near"', '"nep171"')), 'esc.testnet', want)).toBeNull();
    expect(campaignIdFrom(out(ev({}).replace('campaign_created', 'reclaimed')), 'esc.testnet', want)).toBeNull();
  });
});
