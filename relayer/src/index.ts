import { isNearSecretKey, parseNearKey, type NearKey } from './near';
import { handleHealth, handleRelay, type RateLimiter } from './relay';
import { httpRpc } from './rpc';
import { starterAllowed, STARTER_TEXT, STARTER_WAIT_MS, type StarterOutcome } from './starter';

export { StarterGate } from './starter';

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
  STARTER?: { idFromName(name: string): unknown; get(id: unknown): { fetch(req: Request): Promise<Response> } }; // StarterGate
}

let key: Promise<NearKey> | undefined;
let keySecret: string | undefined; // the secret `key` was parsed from
const list = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  return list(env.CLAIM_ORIGINS).includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
}

export default {
  async fetch(req: Request, env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
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
    if ((status === 200 && out.status === 'paid') || (status === 202 && out.status === 'submitted')) {
      // Persist follow-up before answering: the Durable Object reconciles late payment and retries starter failures.
      try {
        const starter = { enabled: env.STARTER_NEAR, network: env.NETWORK, contractId: env.CONTRACT_ID, gasAccountId: env.GAS_ACCOUNT_ID,
          gasKeySecret: env.GAS_KEY, relayerAccountId: env.RELAYER_ACCOUNT_ID, relayerKeySecret: env.RELAYER_KEY, gate: env.STARTER };
        if (starterAllowed(starter)) {
          const claim = body as { destination: string; commitment: string };
          const followUp = JSON.stringify({ txHash: out.tx_hash, destination: claim.destination, commitment: claim.commitment,
            contractId: env.CONTRACT_ID, relayerAccountId: env.RELAYER_ACCOUNT_ID, paid: out.status === 'paid' });
          const sending = (async (): Promise<StarterOutcome> => {
            // The transaction hash makes enrollment idempotent. A failed stub must be recreated.
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const gate = env.STARTER!.get(env.STARTER!.idFromName('gas'));
                const response = await gate.fetch(new Request('https://starter/claim', { method: 'POST', body: followUp }));
                const result = await response.json() as StarterOutcome;
                if (response.ok && result.result !== 'error') return result;
              } catch {
                // Retry only enrollment, never the claim transaction or an ambiguous gas transfer.
              }
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
            }
            console.log('starter_enqueue_failed');
            return { result: 'error' };
          })();
          ctx?.waitUntil(sending.catch(() => {}));
          let timer: ReturnType<typeof setTimeout> | undefined;
          const r = await Promise.race([sending, new Promise<null>((ok) => (timer = setTimeout(() => ok(null), STARTER_WAIT_MS)))]);
          clearTimeout(timer);
          console.log(`starter_${r?.result ?? 'pending'}`);
          if (r?.result === 'sent') return json({ ...out, starter_near: STARTER_TEXT, starter_tx_hash: r.tx_hash }, status);
        }
      } catch {
        console.log('starter_failed');
      }
    }
    return json(out, status);
  },
};
