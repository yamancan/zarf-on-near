// DEMO ENTRY, NEVER DEPLOYED AS THE VERIFIER (wrangler.demo.jsonc only).
// It replaces Google with a throwaway issuer whose RSA key is generated in memory at startup, so
// `make demo` runs the whole claim flow with no Google login and no key material in the repo.
// The release entry (src/index.ts) does not import this file and rejects these tokens.
// workerd treats every named export of an entry as a handler, so this module exports only `default`.
import { DEMO_ISSUER, DEMO_KID, demoKeys, mintDemoToken } from './demoIssuer';
import { makeVerifier, type Env } from './worker';

const verifier = makeVerifier({ jwks: async (kid) => (kid === DEMO_KID ? (await demoKeys()).publicKey : undefined), issuers: [DEMO_ISSUER] });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname === '/demo/token' && req.method === 'POST') {
      const { email, destination } = (await req.json().catch(() => ({}))) as { email?: string; destination?: string };
      if (typeof email !== 'string' || typeof destination !== 'string') return Response.json({ error: 'E108_INVALID_INPUT' }, { status: 400 });
      return Response.json({ id_token: await mintDemoToken({ email, destination, audience: env.GOOGLE_CLIENT_ID }) });
    }
    return verifier.fetch(req, env);
  },
};
