import { httpRpc, stubCreator, testnetCreator, type CampaignCreator } from './creator';
import { handleFaucet } from './faucet';
import type { KvLike } from './limits';
import { parseNearKey } from './near';
import { tryPage, tryScript } from './page';

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
  FAUCET_SENDER_KEY?: string; // secret
  LIMIT_KEY?: string; // secret
  FAUCET_KV: KvLike;
}

const positive = (s: string) => (/^[1-9]\d*$/.test(s ?? '') ? Number(s) : null);

let creator: { from: string; c: Promise<CampaignCreator> } | undefined;

/** Fails closed on any missing or malformed setting; never on mainnet. */
function makeCreator(env: Env): Promise<CampaignCreator> | null {
  if (env.CREATOR === 'stub') return Promise.resolve(stubCreator());
  if (env.CREATOR !== 'testnet' || !env.FAUCET_SENDER_KEY || !env.FAUCET_SENDER_ID || !env.CONTRACT_ID || !env.TOKEN_ID || !env.NEAR_RPC_URL) return null;
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
    const path = new URL(req.url).pathname;
    if (req.method === 'GET' && (path === '/' || path === '/try')) return tryPage();
    if (req.method === 'GET' && path === '/try.js') return tryScript();
    if (req.method !== 'POST' || path !== '/faucet') return json({ error: 'NOT_FOUND' }, 404);

    const amount = /^[1-9]\d{0,38}$/.test(env.AMOUNT ?? '') ? env.AMOUNT : null;
    const lifetimeS = positive(env.LIFETIME_S), perIp = positive(env.PER_IP_PER_DAY);
    const perEmail = positive(env.PER_EMAIL_PER_DAY), cap = positive(env.DAILY_CAP);
    const made = env.NETWORK === 'testnet' ? makeCreator(env) : null;
    if (!made || !amount || !lifetimeS || !perIp || !perEmail || !cap || !env.LIMIT_KEY || !/^https:\/\//.test(env.CLAIM_HOST ?? '')) {
      return json({ error: 'FAUCET_MISCONFIGURED' }, 500);
    }
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { status, body } = await handleFaucet(await req.json().catch(() => null), ip, {
      claimHost: env.CLAIM_HOST, amount, lifetimeS, limitKey: env.LIMIT_KEY, kv: env.FAUCET_KV, creator: await made,
      limits: { perIpPerDay: perIp, perEmailPerDay: perEmail, dailyCap: cap },
    });
    return json(body, status);
  },
};
