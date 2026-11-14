import { describe, expect, it, vi } from 'vitest';
import v from '../../spec/vectors.json';
import worker, { readLimited, resend } from '../src/index';
import { gateStep, PENDING_GIVE_UP_MS, PENDING_RETRY_MS } from '../src/gate';
import { CAP, DAY_CAP, SENDER_DAY_CAP, handleNotify, type Deps } from '../src/notify';
import { claimLink, commitment, rootFromProof } from '../src/proof';

const main = v.campaigns.main;
const decode = (p: string) => {
  const b = atob(p.replace(/-/g, '+').replace(/_/g, '/'));
  const h = Array.from(b, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  return h.match(/.{64}/g) ?? [];
};
// Each fixture link carries its own proof; the request is what /create would send for that row.
const req = (i: number, o: Record<string, unknown> = {}) => {
  const r = main.recipients[i];
  const p = new URLSearchParams(v.links.main[i].split('#')[1]).get('p')!;
  return { campaign_id: main.campaign_id, email: r.email, salt: r.salt, amount: r.amount, proof: decode(p), ...o };
};
const NOW = 1_794_480_000_000; // before the deadline below
const memStore = () => {
  const m = new Map<string, unknown>();
  return { m, get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined, put: async (k: string, x: unknown) => void m.set(k, structuredClone(x)) };
};
const TOKEN = 'usdc.testnet';
const body = (x: unknown) => async () => x;
const clock = { now: 0 };
const CAMPAIGN_GATE = `c.testnet:campaign:${main.campaign_id}`;
function deps(o: Partial<Deps> = {}, store = memStore()) {
  clock.now = 0;
  // One in-memory Durable Object per gate name; `store` is the campaign's, the others start empty.
  const dos = new Map<string, ReturnType<typeof memStore>>([[CAMPAIGN_GATE, store]]);
  const at = (name: string) => (dos.has(name) || dos.set(name, memStore()), dos.get(name)!);
  const sent: { to: string; subject: string; text: string; html: string; key: string }[] = [];
  const d: Deps = {
    getCampaign: async (id) => (id === main.campaign_id ? { sender: 'sender.testnet', token: TOKEN, merkle_root: main.merkle_root, deadline_ns: (BigInt(NOW + 86_400_000) * 1_000_000n).toString(), balance: '100000000' } : null),
    tokenId: TOKEN,
    claimState: async () => 'unclaimed',
    gates: {
      reserve: (name, c, cap) => gateStep(at(name), 'reserve', c, clock.now, cap),
      sent: async (name, c) => void (await gateStep(at(name), 'sent', c, clock.now)),
      release: async (name, c) => void (await gateStep(at(name), 'release', c, clock.now)),
    },
    scope: 'c.testnet',
    senderAllowlist: [],
    send: async (to, mail, key) => (sent.push({ to, ...mail, key }), { ok: true }),
    perIp: { limit: async () => ({ success: true }) },
    nowMs: NOW,
    claimOrigin: 'https://near.zarf.to',
    testnet: true,
    ...o,
  };
  return { d, sent, store, at };
}

describe('claim-link math matches the web (spec/vectors.json, campaign 7)', () => {
  it('commitment, root and link are byte-identical for every fixture row', async () => {
    for (const [i, r] of main.recipients.entries()) {
      const q = req(i);
      const c = await commitment(r.salt, r.email);
      expect(c).toBe(r.commitment);
      expect(await rootFromProof(c, r.amount, q.proof)).toBe(main.merkle_root);
      expect(claimLink('https://near.zarf.to', main.campaign_id, { commitment: c, salt: r.salt, amount: r.amount, proof: q.proof })).toBe(`https://near.zarf.to${v.links.main[i]}`);
    }
  });
});

describe('POST /notify', () => {
  it('a real leaf of a live campaign: one email with the fixed link and template', async () => {
    const { d, sent } = deps();
    const out = await handleNotify(body(req(1)), '1.2.3.4', d);
    expect(out).toEqual({ status: 200, body: { status: 'sent' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('bob.smith@gmail.com'); // the canonical form, the one hashed into the commitment
    expect(sent[0].text).toContain(`https://near.zarf.to${v.links.main[1]}`);
    expect(sent[0].text).toContain('sender.testnet sent you 2.5 Test USDC with Zarf.');
    expect(sent[0].text).toContain('check that the page address starts with https://near.zarf.to/.');
    expect(sent[0].html).toContain('>Claim 2.5 Test USDC on near.zarf.to</a>');
    expect(sent[0].subject).toBe('sender.testnet sent you 2.5 Test USDC on Zarf');
    expect(sent[0].text).toContain('Zarf never asks for a password, a seed phrase or a payment.');
    expect(sent[0].key).toBe(`zarf-c.testnet-7-${main.recipients[1].commitment}`);
  });
  it('wrong proof, wrong amount, wrong salt or unknown campaign → 403, no email', async () => {
    const { d, sent } = deps();
    const bad = [req(0, { proof: req(1).proof }), req(0, { amount: '10000001' }), req(0, { salt: 'a'.repeat(64) }), req(0, { campaign_id: '8' }), req(0, { email: 'eve@gmail.com' })];
    for (const b of bad) expect((await handleNotify(body(b), 'ip', d)).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
  it('past the deadline → 410', async () => {
    const { d, sent } = deps({ nowMs: NOW + 2 * 86_400_000 });
    expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 410, body: { error: 'CAMPAIGN_CLOSED' } });
    expect(sent).toHaveLength(0);
  });
  it('claimed or pending → 409', async () => {
    for (const s of ['claimed', 'pending']) {
      const { d, sent } = deps({ claimState: async () => s });
      expect((await handleNotify(body(req(0)), 'ip', d)).status).toBe(409);
      expect(sent).toHaveLength(0);
    }
  });
  it('a duplicate is idempotent: "already_sent", one email only', async () => {
    const { d, sent } = deps();
    await handleNotify(body(req(0)), 'ip', d);
    expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 200, body: { status: 'already_sent' } });
    expect(await handleNotify(body(req(0, { email: ' ALICE@example.com ' })), 'ip', d)).toEqual({ status: 200, body: { status: 'already_sent' } });
    expect(sent).toHaveLength(1);
  });
  it('over the per-campaign cap → 429, and the count is per campaign', async () => {
    const store = memStore();
    store.m.set('g', { count: CAP, marks: {} });
    const { d, sent } = deps({}, store);
    expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 429, body: { error: 'CAMPAIGN_CAP' } });
    expect(sent).toHaveLength(0);
  });
  it('rate limited per IP → 429 before any chain read', async () => {
    const getCampaign = vi.fn();
    const { d } = deps({ perIp: { limit: async () => ({ success: false }) }, getCampaign });
    expect((await handleNotify(body(req(0)), 'ip', d)).status).toBe(429);
    expect(getCampaign).not.toHaveBeenCalled();
  });
  it('a failed send frees the slot, so a retry sends', async () => {
    let first = true;
    const { d, sent } = deps();
    const send = d.send;
    d.send = async (...a) => (first ? ((first = false), { ok: false, kind: 'refused' }) : send(...a));
    expect((await handleNotify(body(req(0)), 'ip', d)).status).toBe(502);
    expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 200, body: { status: 'sent' } });
    expect(sent).toHaveLength(1);
  });
  it('only the canonical campaign id: "07" is refused, so one campaign has one gate and one cap', async () => {
    const { d } = deps();
    for (const id of ['07', '007', '+7', ' 7', '7.0']) expect((await handleNotify(body(req(0, { campaign_id: id })), 'ip', d)).status).toBe(400);
  });
  it('a leaf the campaign cannot pay, or another token → 403 NOT_FUNDED', async () => {
    const camp = (o: object) => async () => ({ sender: 'sender.testnet', token: TOKEN, merkle_root: main.merkle_root, deadline_ns: (BigInt(NOW + 86_400_000) * 1_000_000n).toString(), balance: '100000000', ...o });
    for (const o of [{ balance: '9999999' }, { token: 'other.testnet' }]) {
      const { d, sent } = deps({ getCampaign: camp(o) });
      expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 403, body: { error: 'NOT_FUNDED' } });
      expect(sent).toHaveLength(0);
    }
  });
  it('while one call is sending, another never reports "sent"', async () => {
    const { d, sent, store } = deps();
    await gateStep(store, 'reserve', main.recipients[0].commitment, 0); // a send in flight
    expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 429, body: { error: 'IN_PROGRESS', retry_after_s: 600 } });
    expect(sent).toHaveLength(0);
  });
  it('an unknown outcome stays pending, then is retried with the same Idempotency-Key, counted once', async () => {
    const { d, sent, store } = deps();
    const send = d.send;
    d.send = async () => { throw new Error('timeout'); };
    expect((await handleNotify(body(req(0)), 'ip', d)).status).toBe(504);
    expect((await handleNotify(body(req(0)), 'ip', d)).status).toBe(429); // too soon
    clock.now = PENDING_RETRY_MS + 1;
    d.send = send;
    expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 200, body: { status: 'sent' } });
    expect(sent.map((x) => x.key)).toEqual([`zarf-c.testnet-7-${main.recipients[0].commitment}`]);
    expect((store.m.get('g') as { count: number }).count).toBe(1);
  });
  it('daily caps: in all and per sender, released again when the campaign gate refuses', async () => {
    const day = new Date(NOW).toISOString().slice(0, 10);
    for (const [name, cap, error] of [[`c.testnet:day:${day}`, DAY_CAP, 'DAILY_CAP'], [`c.testnet:sender:sender.testnet:${day}`, SENDER_DAY_CAP, 'SENDER_DAILY_CAP']] as const) {
      const { d, sent, at } = deps();
      at(name).m.set('g', { count: cap, marks: {} });
      expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 429, body: { error } });
      expect(sent).toHaveLength(0);
      expect((at(CAMPAIGN_GATE).m.get('g') as { count: number }).count).toBe(0); // the campaign slot was given back
    }
  });
  it('a sender allowlist, when set, refuses everyone else', async () => {
    const { d, sent } = deps({ senderAllowlist: ['demo.testnet'] });
    expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 403, body: { error: 'SENDER_NOT_ALLOWED' } });
    expect(sent).toHaveLength(0);
  });
  it('a send unconfirmed for 23 h is never retried blindly (Resend dedupes for 24 h only)', async () => {
    const { d, sent } = deps();
    d.send = async () => { throw new Error('timeout'); };
    await handleNotify(body(req(0)), 'ip', d);
    clock.now = PENDING_GIVE_UP_MS;
    d.send = async (to, mail, key) => (sent.push({ to, ...mail, key }), { ok: true });
    expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status: 504, body: { error: 'SEND_UNCONFIRMED' } });
    expect(sent).toHaveLength(0);
  });
  it('quota and configuration refusals free the slots and say so', async () => {
    for (const [kind, status, error] of [['quota', 503, 'MAIL_QUOTA'], ['config', 500, 'MAILER_MISCONFIGURED']] as const) {
      const { d, at } = deps({ send: async () => ({ ok: false, kind }) });
      expect(await handleNotify(body(req(0)), 'ip', d)).toEqual({ status, body: { error } });
      expect((at(CAMPAIGN_GATE).m.get('g') as { count: number }).count).toBe(0);
    }
  });
  it('a body is read only after the rate limit', async () => {
    let read = false;
    const { d } = deps({ perIp: { limit: async () => ({ success: false }) } });
    await handleNotify(async () => ((read = true), req(0)), 'ip', d);
    expect(read).toBe(false);
  });
  it('malformed bodies → 400', async () => {
    const { d } = deps();
    for (const b of [null, {}, req(0, { campaign_id: 7 }), req(0, { email: 'not-an-email' }), req(0, { email: 'ünï@gmail.com' }), req(0, { salt: 'xyz' }), req(0, { amount: '0' }), req(0, { proof: Array(21).fill('a'.repeat(64)) })]) {
      expect((await handleNotify(body(b), 'ip', d)).status).toBe(400);
    }
  });
  it('the template carries no request text: extra fields never reach the email', async () => {
    const { d, sent } = deps();
    const inject = '<script>alert(1)</script> https://evil.example';
    await handleNotify(body(req(0, { message: inject, subject: inject, from: inject, link: inject, origin: 'https://evil.example' })), 'ip', d);
    const all = JSON.stringify(sent[0]);
    expect(all).not.toContain('evil');
    expect(all).not.toContain('<script>');
    // Every link in it is on the fixed origin.
    for (const u of sent[0].text.match(/https?:\/\/\S+/g) ?? []) expect(u.startsWith('https://near.zarf.to')).toBe(true);
  });
});

describe('worker: origin allowlist', () => {
  const env = { CLAIM_ORIGINS: 'https://near.zarf.to', CLAIM_ORIGIN: 'https://near.zarf.to', MAIL_FROM: 'Zarf <claim@send.zarf.to>', RESEND_API_KEY: 'k', CONTRACT_ID: 'c', NEAR_RPC_URL: 'https://rpc', NETWORK: 'testnet' } as never;
  it('a POST from another origin (or none) → 403 BAD_ORIGIN', async () => {
    for (const h of [{ Origin: 'https://evil.example' }, {} as Record<string, string>]) {
      const r = await worker.fetch(new Request('https://m/notify', { method: 'POST', headers: h, body: JSON.stringify(req(0)) }), env);
      expect(r.status).toBe(403);
      expect(await r.json()).toEqual({ error: 'BAD_ORIGIN' });
    }
  });
  it('preflight answers only allowed origins', async () => {
    const ok = await worker.fetch(new Request('https://m/notify', { method: 'OPTIONS', headers: { Origin: 'https://near.zarf.to' } }), env);
    expect(ok.status).toBe(204);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://near.zarf.to');
    const no = await worker.fetch(new Request('https://m/notify', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
    expect(no.status).toBe(403);
  });
});

describe('MailGate', () => {
  it('reserve, sent, cap, release; one record, commitments only', async () => {
    const s = memStore();
    const [a, b, c] = ['a', 'b', 'c'].map((x) => x.repeat(64));
    expect(await gateStep(s, 'reserve', a, 0, 2)).toBe('ok');
    expect(await gateStep(s, 'reserve', a, 0, 2)).toBe('pending');
    await gateStep(s, 'sent', a, 0, 2);
    expect(await gateStep(s, 'reserve', a, PENDING_RETRY_MS * 9, 2)).toBe('sent');
    expect(await gateStep(s, 'reserve', b, 0, 2)).toBe('ok');
    expect(await gateStep(s, 'reserve', c, 0, 2)).toBe('cap');
    await gateStep(s, 'release', b, 0, 2);
    await gateStep(s, 'release', a, 0, 2); // a sent email is never released
    expect(await gateStep(s, 'reserve', c, 0, 2)).toBe('ok');
    expect([...s.m.keys()]).toEqual(['g']); // one value: every change is one atomic put
    expect(Object.keys((s.m.get('g') as { marks: object }).marks).sort()).toEqual([a, c]);
  });
});

describe('resend(): outcome classes, logs without the address', () => {
  const mail = { subject: 's', text: 't', html: 'h' };
  const env = { RESEND_URL: 'https://resend.stub/emails', RESEND_API_KEY: 'k', MAIL_FROM: 'Zarf <claim@zarf.to>' };
  const at = (status: number, name = 'x') => vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ name }), { status }));
  it('2xx sent; 429 quota; 401/403/422 config; other 4xx refused; 409 and 5xx unknown (throw)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    at(200); expect(await resend(env, 'bob@gmail.com', mail, 'k1')).toEqual({ ok: true });
    at(429, 'daily_quota_exceeded'); expect(await resend(env, 'bob@gmail.com', mail, 'k1')).toEqual({ ok: false, kind: 'quota' });
    for (const s of [401, 403, 422]) { at(s, 'validation_error'); expect(await resend(env, 'bob@gmail.com', mail, 'k1')).toEqual({ ok: false, kind: 'config' }); }
    at(400); expect(await resend(env, 'bob@gmail.com', mail, 'k1')).toEqual({ ok: false, kind: 'refused' });
    for (const s of [409, 500, 503]) { at(s, 'concurrent_idempotent_requests'); await expect(resend(env, 'bob@gmail.com', mail, 'k1')).rejects.toThrow(); }
    expect(JSON.stringify(log.mock.calls)).not.toContain('bob@gmail.com');
    expect(JSON.stringify(log.mock.calls)).toContain('daily_quota_exceeded');
    log.mockRestore();
  });
});

describe('readLimited: a streamed body over 4 kB is cut off and refused', () => {
  const stream = (bytes: number) => new ReadableStream({ start(c) { for (let i = 0; i < bytes; i += 1024) c.enqueue(new Uint8Array(1024).fill(32)); c.close(); } });
  it('no Content-Length, 32 kB → null; a small JSON → parsed', async () => {
    expect(await readLimited(new Request('https://m/notify', { method: 'POST', body: stream(32 * 1024), duplex: 'half' } as RequestInit))).toBeNull();
    expect(await readLimited(new Request('https://m/notify', { method: 'POST', body: '{"a":1}' }))).toEqual({ a: 1 });
  });
});
