import { rpcChain } from './chain';
import { importSigner, type Signer } from './claim';
import { handleClaim } from './claimFlow';
import type { JwksSource } from './jwks';
import { UpstreamError } from './upstream';

export interface Env {
  GOOGLE_CLIENT_ID: string;
  CONTRACT_ID: string;
  NEAR_RPC_URL: string;
  CLAIM_ORIGINS: string; // comma-separated origins of the claim app
  SIGNER_SEED: string; // secret: hex of the 32-byte ed25519 seed
}

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  const allowed = (env.CLAIM_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  return allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : { Vary: 'Origin' };
}

/** The verifier Worker, parameterised by its token issuer. Release (index.ts) passes Google's only. */
export function makeVerifier(o: { jwks: JwksSource; issuers?: string[] }) {
  let signer: Promise<Signer> | undefined;
  let signerSeed: string | undefined; // the SIGNER_SEED `signer` was imported from

  return {
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
      // A malformed seed must fail here, not get cached as a rejected import that looks like an outage.
      if (!/^[0-9a-f]{64}$/.test(env.SIGNER_SEED ?? '') || !env.CONTRACT_ID || !env.GOOGLE_CLIENT_ID || !env.NEAR_RPC_URL) {
        return json({ error: 'VERIFIER_MISCONFIGURED' }, 500);
      }
      // Keyed by the seed, so a rotated secret never keeps signing with the old key.
      if (signerSeed !== env.SIGNER_SEED) {
        signerSeed = env.SIGNER_SEED;
        signer = importSigner(env.SIGNER_SEED);
      }
      try {
        const { status, body: out } = await handleClaim(body, {
          clientId: env.GOOGLE_CLIENT_ID, contractId: env.CONTRACT_ID, jwks: o.jwks, issuers: o.issuers,
          chain: rpcChain(env.NEAR_RPC_URL, env.CONTRACT_ID), signer: await signer!, // set just above whenever the seed changed
        });
        return json(out, status);
      } catch (e) {
        if (!(e instanceof UpstreamError)) throw e;
        // Nothing was signed; keep CORS so the app can say so. Log the fixed tag only: never the
        // request or the error's context, which could carry the salt or the id_token.
        console.log(`upstream_unavailable:${e.source}`);
        return json({ error: 'UPSTREAM_UNAVAILABLE' }, 503);
      }
    },
  };
}
