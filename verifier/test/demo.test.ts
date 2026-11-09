/// <reference types="node" />
// Node only for building the two bundles; the Worker source stays free of Node types (tsconfig types: []).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';
import { claimPayload, unhex } from '../src/claim';
import demo from '../src/demo';
import { DEMO_ISSUER, isLocalRpc } from '../src/demoIssuer';
import { verifyGoogleIdToken } from '../src/googleIdToken';
import release from '../src/index';
import { remoteJwks } from '../src/jwks';
import { jwksResponse, sign, testIssuer } from './jwtFixture';

const named = vectors.claims.valid.find((c) => c.name === 'named-account')!;
const alice = vectors.campaigns.main.recipients.find((r) => r.commitment === named.call_args.commitment)!;
const env = {
  GOOGLE_CLIENT_ID: 'zarf-near-demo-client', CONTRACT_ID: 'zarf-near.testnet', NEAR_RPC_URL: 'http://127.0.0.1:8545',
  SIGNER_SEED: vectors.keys.signer_seed, CLAIM_ORIGINS: '',
};
const post = (worker: { fetch(r: Request, e: typeof env): Promise<Response> }, path: string, body: unknown) =>
  worker.fetch(new Request(`https://v.test${path}`, { method: 'POST', body: JSON.stringify(body) }), env);

// A NEAR RPC stub serving the contract views for campaigns.main.
const views: Record<string, unknown> = {
  get_network: 'testnet',
  get_campaign: { merkle_root: vectors.campaigns.main.merkle_root, deadline_ns: '9'.repeat(19), balance: '1'.repeat(30), policy: 'owner', snapshot: [vectors.keys.signer] },
  claim_state: 'unclaimed',
  get_agent: { kind: 'owner', valid_until_ns: '9'.repeat(19) },
};
const rpcStub = async (url: string, init?: RequestInit) => {
  if (url === 'http://127.0.0.1:8545') {
    const method = JSON.parse(init!.body as string).params.method_name as string;
    return Response.json({ jsonrpc: '2.0', id: 'zarf', result: { result: [...new TextEncoder().encode(JSON.stringify(views[method]))] } });
  }
  return jwksResponse(); // Google's JWKS, as the release entry would fetch it: no demo key in it
};
afterEach(() => vi.unstubAllGlobals());

describe('demo build (src/demo.ts)', () => {
  it('mints a token and runs a full claim through the same verifier code', async () => {
    vi.stubGlobal('fetch', rpcStub);
    const { id_token } = (await (await post(demo, '/demo/token', { email: alice.email, destination: 'alice.testnet' })).json()) as { id_token: string };
    const res = await post(demo, '/claim', {
      id_token, campaign_id: named.call_args.campaign_id, commitment: alice.commitment, amount: alice.amount,
      proof: named.call_args.proof, destination: 'alice.testnet', salt: alice.salt,
    });
    expect(res.status).toBe(200);
    const out = (await res.json()) as Record<string, string>;
    expect(out.signer).toBe(vectors.keys.signer);
    const payload = claimPayload({ network: 'testnet', contract_id: env.CONTRACT_ID, ...out } as never);
    const key = await crypto.subtle.importKey('raw', unhex(out.signer, 32), 'Ed25519', false, ['verify']);
    expect(await crypto.subtle.verify('Ed25519', key, unhex(out.signature, 64), payload)).toBe(true);
  });
});

describe('demo build only runs against a local chain', () => {
  it.each(['https://rpc.testnet.near.org', 'https://127.0.0.1.evil.example', 'http://localhost.evil.example:3030', 'not a url', ''])('refuses NEAR_RPC_URL %j', async (u) => {
    expect(isLocalRpc(u)).toBe(false);
    const res = await demo.fetch(new Request('https://v.test/demo/token', { method: 'POST', body: '{"email":"a@example.com","destination":"alice.testnet"}' }), { ...env, NEAR_RPC_URL: u });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'DEMO_NEEDS_LOCAL_RPC' });
  });
  it.each(['http://127.0.0.1:3030', 'http://localhost:3030'])('accepts %s', (u) => expect(isLocalRpc(u)).toBe(true));
});

describe('release build (src/index.ts) never accepts the demo issuer', () => {
  it('rejects a demo-minted token (its kid is not in the Google JWKS)', async () => {
    vi.stubGlobal('fetch', rpcStub);
    const { id_token } = (await (await post(demo, '/demo/token', { email: alice.email, destination: 'alice.testnet' })).json()) as { id_token: string };
    const res = await post(release, '/claim', {
      id_token, campaign_id: named.call_args.campaign_id, commitment: alice.commitment, amount: alice.amount,
      proof: named.call_args.proof, destination: 'alice.testnet', salt: alice.salt,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'UNKNOWN_KID' });
  });

  it('rejects the demo issuer even with a key it trusts (default issuers are Google only)', async () => {
    const k = await testIssuer('k1');
    const token = await sign(k, { iss: DEMO_ISSUER, aud: 'c', exp: Date.now() / 1000 + 600, email: 'a@example.com', email_verified: true, nonce: 'x' });
    await expect(
      verifyGoogleIdToken(token, { clientId: 'c', destination: 'alice.testnet', jwks: remoteJwks('x', async () => jwksResponse(k)) }),
    ).rejects.toMatchObject({ code: 'BAD_ISSUER' });
  });

  it('has no /demo/token route', async () => {
    const res = await post(release, '/demo/token', { email: 'a@example.com', destination: 'alice.testnet' });
    expect(res.status).toBe(404);
  });

  it('the built release bundle contains no demo issuer, route or key id; the demo bundle does', () => {
    const build = (config: string) => {
      const out = mkdtempSync(join(tmpdir(), 'zarf-verifier-bundle-'));
      execFileSync(join('node_modules', '.bin', 'wrangler'), ['deploy', '--dry-run', '--config', config, '--outdir', out], { stdio: 'pipe' });
      return readdirSync(out, { recursive: true }).filter((f: string | Buffer) => String(f).endsWith('.js')).map((f: string | Buffer) => readFileSync(join(out, String(f)), "utf8")).join('\n');
    };
    const needles = ['demo-issuer.zarf-near.invalid', '/demo/token', 'zarf-near-demo'];
    const releaseJs = build('wrangler.jsonc');
    const demoJs = build('wrangler.demo.jsonc');
    expect(releaseJs.length).toBeGreaterThan(1000);
    for (const n of needles) {
      expect(releaseJs).not.toContain(n);
      expect(demoJs).toContain(n);
    }
  }, 60_000);
});
