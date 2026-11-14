import { describe, expect, it, vi } from 'vitest';
import v from '../../spec/vectors.json';
import worker from '../src/index';
import { gateStep } from '../src/gate';
import { CAP, handleNotify, type Deps } from '../src/notify';
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
  return { m, get: async <T>(k: string) => m.get(k) as T | undefined, put: async (k: string, x: unknown) => void m.set(k, x), delete: async (k: string) => m.delete(k) };
};
function deps(o: Partial<Deps> = {}, store = memStore()) {
  const sent: { to: string; subject: string; text: string; html: string; key: string }[] = [];
  const d: Deps = {
    getCampaign: async (id) => (id === main.campaign_id ? { sender: 'sender.testnet', merkle_root: main.merkle_root, deadline_ns: (BigInt(NOW + 86_400_000) * 1_000_000n).toString() } : null),
    claimState: async () => 'unclaimed',
    gate: { reserve: async (_id, c) => (await gateStep(store, 'reserve', c)) as 'ok', release: async (_id, c) => void (await gateStep(store, 'release', c)) },
    send: async (to, mail, key) => (sent.push({ to, ...mail, key }), true),
    perIp: { limit: async () => ({ success: true }) },
    nowMs: NOW,
    claimOrigin: 'https://near.zarf.to',
    home: 'https://near.zarf.to',
    testnet: true,
    ...o,
  };
  return { d, sent, store };
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
    const out = await handleNotify(req(1), '1.2.3.4', d);
    expect(out).toEqual({ status: 200, body: { status: 'sent' } });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('bob.smith@gmail.com'); // the canonical form, the one hashed into the commitment
    expect(sent[0].text).toContain(`https://near.zarf.to${v.links.main[1]}`);
    expect(sent[0].text).toContain('sender.testnet sent you 2.5 Test USDC with Zarf.');
    expect(sent[0].key).toBe(`zarf-7-${main.recipients[1].commitment}`);
  });
  it('wrong proof, wrong amount, wrong salt or unknown campaign → 403, no email', async () => {
    const { d, sent } = deps();
    const bad = [req(0, { proof: req(1).proof }), req(0, { amount: '10000001' }), req(0, { salt: 'a'.repeat(64) }), req(0, { campaign_id: '8' }), req(0, { email: 'eve@gmail.com' })];
    for (const b of bad) expect((await handleNotify(b, 'ip', d)).status).toBe(403);
    expect(sent).toHaveLength(0);
  });
  it('past the deadline → 410', async () => {
    const { d, sent } = deps({ nowMs: NOW + 2 * 86_400_000 });
    expect(await handleNotify(req(0), 'ip', d)).toEqual({ status: 410, body: { error: 'CAMPAIGN_CLOSED' } });
    expect(sent).toHaveLength(0);
  });
  it('claimed or pending → 409', async () => {
    for (const s of ['claimed', 'pending']) {
      const { d, sent } = deps({ claimState: async () => s });
      expect((await handleNotify(req(0), 'ip', d)).status).toBe(409);
      expect(sent).toHaveLength(0);
    }
  });
  it('a duplicate is idempotent: "already_sent", one email only', async () => {
    const { d, sent } = deps();
    await handleNotify(req(0), 'ip', d);
    expect(await handleNotify(req(0), 'ip', d)).toEqual({ status: 200, body: { status: 'already_sent' } });
    expect(await handleNotify(req(0, { email: ' ALICE@example.com ' }), 'ip', d)).toEqual({ status: 200, body: { status: 'already_sent' } });
    expect(sent).toHaveLength(1);
  });
  it('over the per-campaign cap → 429, and the count is per campaign', async () => {
    const store = memStore();
    store.m.set('count', CAP);
    const { d, sent } = deps({}, store);
    expect(await handleNotify(req(0), 'ip', d)).toEqual({ status: 429, body: { error: 'CAMPAIGN_CAP' } });
    expect(sent).toHaveLength(0);
  });
  it('rate limited per IP → 429 before any chain read', async () => {
    const getCampaign = vi.fn();
    const { d } = deps({ perIp: { limit: async () => ({ success: false }) }, getCampaign });
    expect((await handleNotify(req(0), 'ip', d)).status).toBe(429);
    expect(getCampaign).not.toHaveBeenCalled();
  });
  it('a failed send frees the slot, so a retry sends', async () => {
    let first = true;
    const { d, sent } = deps();
    const send = d.send;
    d.send = async (...a) => (first ? ((first = false), false) : send(...a));
    expect((await handleNotify(req(0), 'ip', d)).status).toBe(502);
    expect(await handleNotify(req(0), 'ip', d)).toEqual({ status: 200, body: { status: 'sent' } });
    expect(sent).toHaveLength(1);
  });
  it('malformed bodies → 400', async () => {
    const { d } = deps();
    for (const b of [null, {}, req(0, { campaign_id: 7 }), req(0, { email: 'not-an-email' }), req(0, { email: 'ünï@gmail.com' }), req(0, { salt: 'xyz' }), req(0, { amount: '0' }), req(0, { proof: Array(21).fill('a'.repeat(64)) })]) {
      expect((await handleNotify(b, 'ip', d)).status).toBe(400);
    }
  });
  it('the template carries no request text: extra fields never reach the email', async () => {
    const { d, sent } = deps();
    const inject = '<script>alert(1)</script> https://evil.example';
    await handleNotify(req(0, { message: inject, subject: inject, from: inject, link: inject, origin: 'https://evil.example' }), 'ip', d);
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
  it('reserve once, cap, release', async () => {
    const s = memStore();
    expect(await gateStep(s, 'reserve', 'a'.repeat(64), 2)).toBe('ok');
    expect(await gateStep(s, 'reserve', 'a'.repeat(64), 2)).toBe('already');
    expect(await gateStep(s, 'reserve', 'b'.repeat(64), 2)).toBe('ok');
    expect(await gateStep(s, 'reserve', 'c'.repeat(64), 2)).toBe('cap');
    await gateStep(s, 'release', 'b'.repeat(64), 2);
    expect(await gateStep(s, 'reserve', 'c'.repeat(64), 2)).toBe('ok');
    expect([...s.m.keys()].every((k) => k === 'count' || /^c:[0-9a-f]{64}$/.test(k))).toBe(true); // commitments only
  });
});
