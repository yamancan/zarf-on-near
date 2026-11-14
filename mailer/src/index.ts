import { MailGate } from './gate';
import { handleNotify, type RateLimiter, type SendResult } from './notify';
import type { Mail } from './template';

export { MailGate };

interface Env {
  NETWORK: string;
  CONTRACT_ID: string;
  NEAR_RPC_URL: string;
  CLAIM_ORIGINS: string; // pages allowed to call /notify (CORS + Origin check)
  CLAIM_ORIGIN: string; // the one origin every emailed link uses
  MAIL_FROM: string; // "Zarf <claim@zarf.to>" (zarf.to is the domain verified in Resend)
  SENDER_ALLOWLIST?: string; // comma-separated sender accounts; empty = every sender
  TOKEN_ID: string; // the USDC token the emails name
  RESEND_URL?: string; // tests and local dev point this at a stub; default Resend's API
  RESEND_API_KEY: string; // secret
  PER_IP: RateLimiter;
  GATE: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request | string): Promise<Response> } };
}

const RPC_TIMEOUT_MS = 8000;
const MAX_BODY = 4096; // one recipient's leaf with a 20-level proof is under 2 kB
const list = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function view<T>(env: Env, method: string, args: object): Promise<T> {
  return fetch(env.NEAR_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'zarf', method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: env.CONTRACT_ID, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  }).then(async (res) => {
    const body = (await res.json().catch(() => null)) as { result?: { result?: number[] }; error?: unknown } | null;
    if (!res.ok || !body || body.error || !body.result?.result) throw new Error(`rpc view ${method} failed`);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(body.result.result))) as T;
  });
}

/**
 * One email through Resend. Throws when the outcome is unknown (timeout, network, 5xx, or a concurrent request with
 * the same Idempotency-Key still running), so the mark stays pending. Logs Resend's error name and status only.
 */
export async function resend(env: Pick<Env, 'RESEND_URL' | 'RESEND_API_KEY' | 'MAIL_FROM'>, to: string, mail: Mail, idempotencyKey: string): Promise<SendResult> {
  const res = await fetch(env.RESEND_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (res.ok) return { ok: true };
  const name = String(((await res.json().catch(() => null)) as { name?: unknown } | null)?.name ?? '').replace(/[^a-z_]/gi, '').slice(0, 60);
  console.log('resend refused', res.status, name); // never the address, the link or the body
  if (res.status >= 500 || res.status === 409) throw new Error('resend outcome unknown');
  if (res.status === 429) return { ok: false, kind: 'quota' };
  if (res.status === 401 || res.status === 403 || res.status === 422) return { ok: false, kind: 'config' };
  return { ok: false, kind: 'refused' };
}

/** The body, at most MAX_BODY bytes read; anything longer is cancelled and refused. */
export async function readLimited(req: Request): Promise<unknown> {
  if (Number(req.headers.get('Content-Length') ?? 0) > MAX_BODY || !req.body) return null;
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_BODY) {
      await reader.cancel();
      return null;
    }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let off = 0;
  for (const p of parts) all.set(p, (off += p.length) - p.length);
  return JSON.parse(new TextDecoder().decode(all));
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin') ?? '';
    const allowed = list(env.CLAIM_ORIGINS).includes(origin);
    const headers: Record<string, string> = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    const json = (body: unknown, status: number) => Response.json(body, { status, headers });
    const path = new URL(req.url).pathname;
    if (path === '/health' && req.method === 'GET') return json({ ok: true, configured: !!(env.RESEND_API_KEY && env.CONTRACT_ID && env.TOKEN_ID && env.MAIL_FROM) }, 200);
    if (path !== '/notify') return json({ error: 'NOT_FOUND' }, 404);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: allowed ? 204 : 403,
        headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
      });
    }
    if (req.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
    if (!allowed) return json({ error: 'BAD_ORIGIN' }, 403);
    if (!env.RESEND_API_KEY || !env.CONTRACT_ID || !env.NEAR_RPC_URL || !env.CLAIM_ORIGIN || !env.MAIL_FROM || !env.TOKEN_ID) return json({ error: 'MAILER_MISCONFIGURED' }, 500);
    const gateCall = async (name: string, c: string, op: string, cap = 1) => {
      const stub = env.GATE.get(env.GATE.idFromName(name));
      const r = (await (await stub.fetch(`https://gate/?op=${op}&c=${c}&cap=${cap}`)).json()) as { result: string };
      return r.result;
    };
    try {
      // The body is read only after the rate limit (handleNotify), and never more than MAX_BODY.
      const out = await handleNotify(() => readLimited(req), req.headers.get('CF-Connecting-IP') ?? 'unknown', {
        getCampaign: (id) => view(env, 'get_campaign', { campaign_id: id }),
        tokenId: env.TOKEN_ID,
        claimState: (id, c) => view<string>(env, 'claim_state', { campaign_id: id, commitment: c }),
        gates: {
          reserve: (name, c, cap) => gateCall(name, c, 'reserve', cap) as never,
          sent: async (name, c) => void (await gateCall(name, c, 'sent')),
          release: async (name, c) => void (await gateCall(name, c, 'release')),
        },
        scope: env.CONTRACT_ID,
        senderAllowlist: list(env.SENDER_ALLOWLIST),
        send: (to, mail, key) => resend(env, to, mail, key),
        perIp: env.PER_IP,
        nowMs: Date.now(),
        claimOrigin: env.CLAIM_ORIGIN,
        testnet: env.NETWORK !== 'mainnet',
      });
      return json(out.body, out.status);
    } catch {
      console.log('notify error'); // no detail: an RPC error could echo arguments
      return json({ error: 'TRY_AGAIN' }, 503);
    }
  },
};
