import { httpRpc, stubCreator, testnetCreator, type CampaignCreator } from './creator';
import { handleFaucet } from './faucet';
import type { KvLike } from './limits';
import { parseNearKey } from './near';
import { tryPage, tryScript } from './page';
import { isTurnstileTestKey, verifyTurnstile } from './turnstile';

export interface Env {
  NETWORK: string;
  CLAIM_HOST: string;
  CONTRACT_ID: string;
  TOKEN_ID: string;
  NEAR_RPC_URL: string;
  FAUCET_SENDER_ID: string;
  CREATOR: string; // "stub" | "testnet"
  AMOUNT: string;
  LIFETIME_S: string;
  PER_IP_PER_DAY: string;
  PER_EMAIL_PER_DAY: string;
  DAILY_CAP: string;
  TURNSTILE_SITE_KEY: string;
  FAUCET_SENDER_KEY?: string; // secret
  LIMIT_KEY?: string; // secret
  TURNSTILE_SECRET?: string; // secret
  FAUCET_KV: KvLike;
}

const positive = (s: string) => (/^[1-9]\d*$/.test(s ?? '') ? Number(s) : null);

let creator: { from: string; c: Promise<CampaignCreator> } | undefined;
const chainChecked = new Map<string, Promise<boolean>>(); // per RPC URL: did `status` say chain_id === "testnet"?

/** The RPC must itself report testnet; a failed lookup is not cached, so the next request retries. */
function rpcIsTestnet(url: string): Promise<boolean> {
  let p = chainChecked.get(url);
  if (!p) {
    p = httpRpc(url).call<{ chain_id?: string }>('status', []).then((s) => s.chain_id === 'testnet');
    p.catch(() => chainChecked.delete(url));
    chainChecked.set(url, p);
  }
  return p;
}

const LOCAL_HOSTS = ['localhost', '127.0.0.1'];

/** Fails closed on any missing or malformed setting; never on mainnet. The stub runs only on a local host. */
function makeCreator(env: Env, host: string): Promise<CampaignCreator> | null {
  if (env.CREATOR === 'stub') return LOCAL_HOSTS.includes(host) ? Promise.resolve(stubCreator()) : null;
  if (env.CREATOR !== 'testnet' || !env.FAUCET_SENDER_KEY || !env.TOKEN_ID || !env.NEAR_RPC_URL) return null;
  if (!env.FAUCET_SENDER_ID?.endsWith('.testnet') || !env.CONTRACT_ID?.endsWith('.testnet')) return null;
  const from = `${env.FAUCET_SENDER_ID}|${env.FAUCET_SENDER_KEY}`;
  if (creator?.from !== from) {
    creator = {
      from,
      c: parseNearKey(env.FAUCET_SENDER_KEY).then((key) =>
        testnetCreator({ rpc: httpRpc(env.NEAR_RPC_URL), senderId: env.FAUCET_SENDER_ID, key, tokenId: env.TOKEN_ID, contractId: env.CONTRACT_ID }),
      ),
    };
  }
  return creator.c;
}

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), path = url.pathname;
    if (req.method === 'GET' && (path === '/' || path === '/try')) return tryPage(env.TURNSTILE_SITE_KEY ?? '');
    if (req.method === 'GET' && path === '/try.js') return tryScript();
    if (req.method !== 'POST' || path !== '/faucet') return json({ error: 'NOT_FOUND' }, 404);

    const amount = /^[1-9]\d{0,38}$/.test(env.AMOUNT ?? '') ? env.AMOUNT : null;
    const lifetimeS = positive(env.LIFETIME_S), perIp = positive(env.PER_IP_PER_DAY);
    const perEmail = positive(env.PER_EMAIL_PER_DAY), cap = positive(env.DAILY_CAP);
    const local = LOCAL_HOSTS.includes(url.hostname);
    const made = env.NETWORK === 'testnet' ? makeCreator(env, url.hostname) : null;
    // Test keys always pass, so off localhost they would switch the human check off.
    const testKeys = isTurnstileTestKey(env.TURNSTILE_SECRET ?? '') || isTurnstileTestKey(env.TURNSTILE_SITE_KEY ?? '');
    if (!made || !amount || !lifetimeS || !perIp || !perEmail || !cap || !env.LIMIT_KEY || !/^https:\/\//.test(env.CLAIM_HOST ?? '') ||
        !env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY || (testKeys && !local)) {
      return json({ error: 'FAUCET_MISCONFIGURED' }, 500);
    }
    if (env.CREATOR === 'testnet') {
      const testnet = await rpcIsTestnet(env.NEAR_RPC_URL).catch(() => null);
      if (testnet === null) return json({ error: 'UPSTREAM_UNAVAILABLE' }, 503);
      if (!testnet) return json({ error: 'FAUCET_MISCONFIGURED' }, 500);
    }
    // A JSON content type forces a CORS preflight, so a cross-site form cannot post here.
    if (!/^application\/json\b/i.test(req.headers.get('Content-Type') ?? '')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    const input = (await req.json().catch(() => null)) as { turnstile?: unknown } | null;
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    // Before the quota: a bot without a valid token spends nobody's daily allowance.
    const human = await verifyTurnstile(input?.turnstile, env.TURNSTILE_SECRET, ip, local ? null : url.hostname);
    if (human === 'unavailable') return json({ error: 'TURNSTILE_UNAVAILABLE' }, 503);
    if (human === 'failed') return json({ error: 'TURNSTILE_FAILED' }, 403);
    const { status, body } = await handleFaucet(input, ip, {
      claimHost: env.CLAIM_HOST, amount, lifetimeS, limitKey: env.LIMIT_KEY, kv: env.FAUCET_KV, creator: await made,
      limits: { perIpPerDay: perIp, perEmailPerDay: perEmail, dailyCap: cap },
    });
    return json(body, status);
  },
};
