import { httpRpc, stubCreator, testnetCreator, viewCall, type CampaignCreator } from './creator';
import { handleFaucet } from './faucet';
import type { KvLike } from './limits';
import { parseNearKey } from './near';
import { pageAsset, tryPage, tryScript } from './page';
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
  PROXY_KEY?: string; // secret shared with proxy/ (near.zarf.to): marks the visitor IP it forwards as trusted
  FAUCET_KV: KvLike;
  PER_IP?: RateLimiter; // Workers rate-limit binding: a burst guard in front of Turnstile and the chain
}

/** The Cloudflare rate-limit binding's interface (as in the relayer). */
export interface RateLimiter {
  limit(o: { key: string }): Promise<{ success: boolean }>;
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

/**
 * The visitor's IP for the limits. Through near.zarf.to (proxy/) the request arrives from Cloudflare's own address,
 * so the proxy forwards the visitor's in X-Zarf-Client-IP; it counts only with the shared PROXY_KEY.
 */
export const clientIp = (req: Request, proxyKey: string | undefined): string =>
  (proxyKey && req.headers.get('X-Zarf-Proxy-Key') === proxyKey && req.headers.get('X-Zarf-Client-IP')) || req.headers.get('CF-Connecting-IP') || 'unknown';

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

type Float = { float: string; prepay: string };
const FLOAT_TTL_MS = 20_000;
// Per isolate. /health and POST /faucet share it, so a loop on either costs at most one RPC round per
// 20 s, not two views per request against FastNEAR's per-IP limit. A stale "not empty" is harmless:
// the create itself fails on an empty float. A failed read is never cached.
const floatCache = new Map<string, { at: number; value: Promise<Float> }>();

function cachedFloat(env: Env, nowMs = Date.now()): Promise<Float> {
  const key = `${env.NEAR_RPC_URL}|${env.TOKEN_ID}|${env.CONTRACT_ID}|${env.FAUCET_SENDER_ID}`;
  const hit = floatCache.get(key);
  if (hit && nowMs - hit.at < FLOAT_TTL_MS) return hit.value;
  const value = readFloat(env);
  floatCache.set(key, { at: nowMs, value });
  value.catch(() => {
    if (floatCache.get(key)?.value === value) floatCache.delete(key);
  });
  return value;
}

/** The faucet's float on chain: its USDC balance and its free storage pre-pay on the escrow. Public data. */
async function readFloat(env: Env): Promise<Float> {
  const rpc = httpRpc(env.NEAR_RPC_URL);
  const [float, prepay] = await Promise.all([
    viewCall<string>(rpc, env.TOKEN_ID, 'ft_balance_of', { account_id: env.FAUCET_SENDER_ID }),
    viewCall<string>(rpc, env.CONTRACT_ID, 'prepay_balance_of', { account_id: env.FAUCET_SENDER_ID }),
  ]);
  if (!/^\d+$/.test(String(float)) || !/^\d+$/.test(String(prepay))) throw new Error('bad view');
  return { float: String(float), prepay: String(prepay) };
}

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url), path = url.pathname;
    if (req.method === 'GET' && (path === '/' || path === '/try')) return tryPage(env.TURNSTILE_SITE_KEY ?? '', env.CLAIM_HOST ?? '', env.AMOUNT ?? '');
    if (req.method === 'GET' && path === '/try.js') return tryScript();
    const asset = req.method === 'GET' ? pageAsset(path) : null;
    if (asset) return asset;
    if (req.method === 'GET' && path === '/health') {
      // Public: chain ids and balances only, never a secret. 503 when the chain read fails.
      if (env.CREATOR !== 'testnet') return json({ ok: true, stub: true }, 200);
      try {
        const { float, prepay } = await cachedFloat(env);
        const per = /^[1-9]\d{0,38}$/.test(env.AMOUNT ?? '') ? BigInt(env.AMOUNT) : 0n;
        return json({
          ok: true, network: env.NETWORK, contract_id: env.CONTRACT_ID, sender_id: env.FAUCET_SENDER_ID, token_id: env.TOKEN_ID,
          amount_per_link: env.AMOUNT, float, links_left: per ? (BigInt(float) / per).toString() : '0', prepay_yocto: prepay,
        }, 200);
      } catch {
        return json({ ok: false, error: 'UPSTREAM_UNAVAILABLE' }, 503);
      }
    }
    if (req.method !== 'POST' || path !== '/faucet') return json({ error: 'NOT_FOUND' }, 404);

    const amount = /^[1-9]\d{0,38}$/.test(env.AMOUNT ?? '') ? env.AMOUNT : null;
    const lifetimeS = positive(env.LIFETIME_S), perIp = positive(env.PER_IP_PER_DAY);
    const perEmail = positive(env.PER_EMAIL_PER_DAY), cap = positive(env.DAILY_CAP);
    const local = LOCAL_HOSTS.includes(url.hostname);
    const made = env.NETWORK === 'testnet' ? makeCreator(env, url.hostname) : null;
    // Test keys always pass, so off localhost they would switch the human check off.
    const testKeys = isTurnstileTestKey(env.TURNSTILE_SECRET ?? '') || isTurnstileTestKey(env.TURNSTILE_SITE_KEY ?? '');
    if (!made || !amount || !lifetimeS || !perIp || !perEmail || !cap || !env.LIMIT_KEY || !/^https:\/\//.test(env.CLAIM_HOST ?? '') ||
        !env.TURNSTILE_SECRET || !env.TURNSTILE_SITE_KEY || (testKeys && !local) || !env.PER_IP) {
      return json({ error: 'FAUCET_MISCONFIGURED' }, 500);
    }
    if (env.CREATOR === 'testnet') {
      const testnet = await rpcIsTestnet(env.NEAR_RPC_URL).catch(() => null);
      if (testnet === null) return json({ error: 'UPSTREAM_UNAVAILABLE' }, 503);
      if (!testnet) return json({ error: 'FAUCET_MISCONFIGURED' }, 500);
    }
    // A JSON content type forces a CORS preflight, so a cross-site form cannot post here.
    if (!/^application\/json\b/i.test(req.headers.get('Content-Type') ?? '')) return json({ error: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
    const ip = clientIp(req, env.PROXY_KEY);
    // A burst from one IP stops here, before the float read, siteverify and the quota.
    if (!(await env.PER_IP.limit({ key: ip })).success) return json({ error: 'RATE_LIMITED_BURST' }, 429);
    if (env.CREATOR === 'testnet') {
      // Before the human check and the quota: an empty faucet spends nobody's token or allowance.
      const f = await cachedFloat(env).catch(() => null);
      if (!f) return json({ error: 'UPSTREAM_UNAVAILABLE' }, 503);
      if (BigInt(f.float) < BigInt(amount)) return json({ error: 'FAUCET_EMPTY' }, 503);
    }
    const input = (await req.json().catch(() => null)) as { turnstile?: unknown } | null;
    // Before the quota: a bot without a valid token spends nobody's daily allowance.
    // The widget runs on this host or on the claim host (near.zarf.to serves /try through proxy/).
    const human = await verifyTurnstile(input?.turnstile, env.TURNSTILE_SECRET, ip, local ? null : [url.hostname, new URL(env.CLAIM_HOST).hostname]);
    if (human === 'unavailable') return json({ error: 'TURNSTILE_UNAVAILABLE' }, 503);
    if (human === 'failed') return json({ error: 'TURNSTILE_FAILED' }, 403);
    const { status, body } = await handleFaucet(input, ip, {
      claimHost: env.CLAIM_HOST, amount, lifetimeS, limitKey: env.LIMIT_KEY, kv: env.FAUCET_KV, creator: await made,
      limits: { perIpPerDay: perIp, perEmailPerDay: perEmail, dailyCap: cap },
    });
    return json(body, status);
  },
};
