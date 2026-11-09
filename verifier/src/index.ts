import { TokenError, verifyGoogleIdToken } from './googleIdToken';
import { GOOGLE_JWKS_URL, remoteJwks } from './jwks';

interface Env {
  GOOGLE_CLIENT_ID: string;
}

// Release builds use Google's JWKS only; there is no env switch to another issuer.
const jwks = remoteJwks(GOOGLE_JWKS_URL);

const json = (body: unknown, status: number) => Response.json(body, { status });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/claim') return json({ error: 'NOT_FOUND' }, 404);
    const body = (await req.json().catch(() => null)) as { id_token?: unknown; destination?: unknown } | null;
    if (typeof body?.id_token !== 'string' || typeof body.destination !== 'string') return json({ error: 'BAD_REQUEST' }, 400);
    try {
      await verifyGoogleIdToken(body.id_token, { clientId: env.GOOGLE_CLIENT_ID, destination: body.destination, jwks });
    } catch (e) {
      if (e instanceof TokenError) return json({ error: e.code }, 401);
      throw e;
    }
    // T4b: read get_network + get_campaign, check the deadline, recompute HMAC(salt, email), verify the proof, sign.
    return json({ error: 'NOT_IMPLEMENTED' }, 501);
  },
};
