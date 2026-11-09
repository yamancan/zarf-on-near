import { undeployedChain } from './chain';
import { importSigner, type Signer } from './claim';
import { handleClaim } from './claimFlow';
import { GOOGLE_JWKS_URL, remoteJwks } from './jwks';

interface Env {
  GOOGLE_CLIENT_ID: string;
  CONTRACT_ID: string;
  CLAIM_ORIGINS: string; // comma-separated origins of the claim app
  SIGNER_SEED: string; // secret: hex of the 32-byte ed25519 seed
}

// Release builds use Google's JWKS only; there is no env switch to another issuer.
const jwks = remoteJwks(GOOGLE_JWKS_URL);
let signer: Promise<Signer> | undefined;

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = (env.CLAIM_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const headers = cors(req, env);
    const json = (body: unknown, status: number) => Response.json(body, { status, headers });
    if (new URL(req.url).pathname !== '/claim') return json({ error: 'NOT_FOUND' }, 404);
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: { ...headers, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' },
      });
    }
    if (req.method !== 'POST') return json({ error: 'NOT_FOUND' }, 404);

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'E108_INVALID_INPUT' }, 400);
    if (!env.SIGNER_SEED || !env.CONTRACT_ID || !env.GOOGLE_CLIENT_ID) return json({ error: 'VERIFIER_MISCONFIGURED' }, 500);
    signer ??= importSigner(env.SIGNER_SEED);
    try {
      const { status, body: out } = await handleClaim(body, {
        clientId: env.GOOGLE_CLIENT_ID, contractId: env.CONTRACT_ID, jwks, chain: undeployedChain, signer: await signer,
      });
      return json(out, status);
    } catch {
      // Google's JWKS or the chain read failed. Nothing was signed; keep CORS so the app can say so.
      // Never log the request or the error's context: it carries the salt and the id_token.
      return json({ error: 'UPSTREAM_UNAVAILABLE' }, 503);
    }
  },
};
