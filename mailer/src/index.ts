import { MailGate } from './gate';
import { handleNotify, type RateLimiter } from './notify';
import type { Mail } from './template';

export { MailGate };

interface Env {
  NETWORK: string;
  CONTRACT_ID: string;
  NEAR_RPC_URL: string;
  CLAIM_ORIGINS: string; // pages allowed to call /notify (CORS + Origin check)
  CLAIM_ORIGIN: string; // the one origin every emailed link uses
  MAIL_FROM: string; // "Zarf <claim@send.zarf.to>"
  RESEND_URL?: string; // tests and local dev point this at a stub; default Resend's API
  RESEND_API_KEY: string; // secret
  PER_IP: RateLimiter;
  GATE: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request | string): Promise<Response> } };
}

const RPC_TIMEOUT_MS = 8000;
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

async function resend(env: Env, to: string, mail: Mail, idempotencyKey: string): Promise<boolean> {
  const res = await fetch(env.RESEND_URL || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (!res.ok) console.log('resend status', res.status); // the status only: never the address or the body
  return res.ok;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const origin = req.headers.get('Origin') ?? '';
    const allowed = list(env.CLAIM_ORIGINS).includes(origin);
    const headers: Record<string, string> = allowed ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
    const json = (body: unknown, status: number) => Response.json(body, { status, headers });
    const path = new URL(req.url).pathname;
    if (path === '/health' && req.method === 'GET') return json({ ok: true }, 200);
    if (path !== '/notify') return json({ error: 'NOT_FOUND' }, 404);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: allowed ? 204 : 403,
        headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
      });
    }
    if (req.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);
    if (!allowed) return json({ error: 'BAD_ORIGIN' }, 403);
    if (!env.RESEND_API_KEY || !env.CONTRACT_ID || !env.NEAR_RPC_URL || !env.CLAIM_ORIGIN || !env.MAIL_FROM) return json({ error: 'MAILER_MISCONFIGURED' }, 500);
    const body = await req.json().catch(() => null);
    const gateCall = async (campaignId: string, c: string, op: string) => {
      const stub = env.GATE.get(env.GATE.idFromName(`campaign:${campaignId}`));
      const r = (await (await stub.fetch(`https://gate/?op=${op}&c=${c}`)).json()) as { result: string };
      return r.result;
    };
    try {
      const out = await handleNotify(body, req.headers.get('CF-Connecting-IP') ?? 'unknown', {
        getCampaign: (id) => view(env, 'get_campaign', { campaign_id: id }),
        claimState: (id, c) => view<string>(env, 'claim_state', { campaign_id: id, commitment: c }),
        gate: {
          reserve: (id, c) => gateCall(id, c, 'reserve') as Promise<'ok' | 'already' | 'cap'>,
          release: async (id, c) => void (await gateCall(id, c, 'release')),
        },
        send: (to, mail, key) => resend(env, to, mail, key),
        perIp: env.PER_IP,
        nowMs: Date.now(),
        claimOrigin: env.CLAIM_ORIGIN,
        home: env.CLAIM_ORIGIN,
        testnet: env.NETWORK !== 'mainnet',
      });
      return json(out.body, out.status);
    } catch {
      console.log('notify error'); // no detail: an RPC error could echo arguments
      return json({ error: 'TRY_AGAIN' }, 503);
    }
  },
};
