import { isNearSecretKey, parseNearKey, type NearKey } from './near';
import { handleHealth, handleRelay, type RateLimiter } from './relay';
import { httpRpc } from './rpc';
import { sendStarter, starterAllowed, STARTER_TEXT, type KvLike } from './starter';

interface Env {
  NETWORK: string;
  CONTRACT_ID: string;
  RELAYER_ACCOUNT_ID: string;
  NEAR_RPC_URL: string;
  VERIFIER_SIGNERS: string; // comma-separated hex32
  CLAIM_ORIGINS: string;
  RELAYER_KEY: string; // secret: a function-call key limited to <CONTRACT_ID>.claim
  PER_IP: RateLimiter;
  PER_COMMITMENT: RateLimiter;
  // Testnet starter NEAR (starter.ts). Off unless STARTER_NEAR=on; never on mainnet.
  STARTER_NEAR?: string;
  GAS_ACCOUNT_ID?: string;
  GAS_KEY?: string; // secret: full-access key of GAS_ACCOUNT_ID only, never the relayer key
  STARTER_KV?: KvLike;
}

let key: Promise<NearKey> | undefined;
let keySecret: string | undefined; // the secret `key` was parsed from
let gasKey: { secret: string; key: Promise<NearKey> } | undefined;
const list = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return list(env.CLAIM_ORIGINS).includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const headers = cors(req, env);
    const json = (body: unknown, status: number) => Response.json(body, { status, headers });
    const path = new URL(req.url).pathname;
    if (path !== '/claim' && path !== '/health') return json({ error: 'NOT_FOUND' }, 404);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
      });
    }
    if (req.method !== (path === '/health' ? 'GET' : 'POST')) return json({ error: 'NOT_FOUND' }, 404);
    if (!isNearSecretKey(env.RELAYER_KEY) || !env.CONTRACT_ID || !env.NETWORK || !env.RELAYER_ACCOUNT_ID || !env.NEAR_RPC_URL || !list(env.VERIFIER_SIGNERS).length) {
      return json({ error: 'RELAYER_MISCONFIGURED' }, 500);
    }
    // A key whose public half does not match its seed fails here every time; never cache the rejection.
    if (keySecret !== env.RELAYER_KEY) {
      keySecret = env.RELAYER_KEY;
      key = parseNearKey(env.RELAYER_KEY).catch((e) => {
        key = keySecret = undefined; // never cache a rejection
        throw e;
      });
    }
    let k: NearKey;
    try {
      k = await key!; // set just above whenever the secret changed
    } catch {
      console.log('misconfigured');
      return json({ error: 'RELAYER_MISCONFIGURED' }, 500);
    }
    const ip = req.headers.get('CF-Connecting-IP') ?? 'unknown';
    const rpc = httpRpc(env.NEAR_RPC_URL);
    if (path === '/health') {
      const { status, body } = await handleHealth({ rpc, relayerAccountId: env.RELAYER_ACCOUNT_ID, key: k, perIp: env.PER_IP, contractId: env.CONTRACT_ID }, ip);
      return json(body, status);
    }
    const body = await req.json().catch(() => null);
    const { status, body: out } = await handleRelay(body, ip, {
      rpc, network: env.NETWORK, contractId: env.CONTRACT_ID, relayerAccountId: env.RELAYER_ACCOUNT_ID,
      key: k, verifierSigners: list(env.VERIFIER_SIGNERS), perIp: env.PER_IP, perCommitment: env.PER_COMMITMENT,
    });
    if (status === 200 && out.status === 'paid') {
      const starter = { enabled: env.STARTER_NEAR, network: env.NETWORK, contractId: env.CONTRACT_ID, gasAccountId: env.GAS_ACCOUNT_ID,
        gasKeySecret: env.GAS_KEY, relayerKeySecret: env.RELAYER_KEY, kv: env.STARTER_KV };
      if (starterAllowed(starter)) {
        // The claim is already paid: nothing here may change that answer, so every failure is only logged.
        try {
          let cached = gasKey;
          if (!cached || cached.secret !== env.GAS_KEY) cached = gasKey = { secret: env.GAS_KEY!, key: parseNearKey(env.GAS_KEY!) };
          const k = await cached.key;
          const r = await sendStarter((body as { destination: string }).destination, { rpc, gasAccountId: env.GAS_ACCOUNT_ID!, gasKey: k, kv: env.STARTER_KV! });
          console.log(`starter_${r.result}`);
          if (r.result === 'sent') return json({ ...out, starter_near: STARTER_TEXT, starter_tx_hash: r.tx_hash }, status);
        } catch {
          gasKey = undefined;
          console.log('starter_failed');
        }
      }
    }
    return json(out, status);
  },
};
