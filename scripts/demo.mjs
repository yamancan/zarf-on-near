#!/usr/bin/env node
// `make demo`: the whole claim flow from a clean clone, with no secrets and no Google login.
//
//   node scripts/demo.mjs --dry   mocked NEAR RPC (exercises verifier + relayer end to end today)
//   node scripts/demo.mjs         against a NEAR sandbox; reads the seam below from env
//
// Sandbox seam (set by the contract side's seed script):
//   NEAR_RPC_URL         sandbox JSON-RPC endpoint
//   CONTRACT_ID          escrow account; its `network` init arg must equal NETWORK (default "testnet")
//   RELAYER_ACCOUNT_ID   account holding a function-call key for CONTRACT_ID / ["claim"]
//   RELAYER_KEY          that key, ed25519:<base58>
//   DEMO_CAMPAIGN_ID     campaign created from spec/vectors.json campaigns.<DEMO_VECTOR_CAMPAIGN>
//                        (same leaves and merkle_root), with keys.signer registered (add_owner_key)
//   DEMO_VECTOR_CAMPAIGN "single" (solo@example.com, 5 USDC; the sandbox default) or "main"
//                        (alice@example.com; total u128::MAX, so it needs a mintable token). --dry uses "main".
//   DEMO_DESTINATION     account that receives the tokens (default alice.testnet)
//   DEMO_REQUIRE_RPC=1   a sandbox run (scripts/demo-sandbox.sh sets it): never fall back to --dry
// The demo verifier signs with spec/vectors.json keys.signer_seed: a public test key, sandbox only.

import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { unstable_dev } = require(`${root}relayer/node_modules/wrangler`);
const vectors = JSON.parse(readFileSync(`${root}spec/vectors.json`, 'utf8'));
const { base58, startMockRpc } = await import(`${root}scripts/mock-near-rpc.mjs`);

const dry = process.argv.includes('--dry');
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const fail = (msg) => {
  console.error(`\nDEMO FAILED: ${msg}`);
  process.exitCode = 1;
};

// ---- which claim ------------------------------------------------------------------------------
const which = process.env.DEMO_VECTOR_CAMPAIGN ?? (dry ? 'main' : 'single');
const campaign = vectors.campaigns[which];
const claimVector = vectors.claims.valid.find((c) => c.campaign === which);
if (!campaign || !claimVector) throw new Error(`no vector campaign "${which}"`);
const recipient = campaign.recipients.find((r) => r.commitment === claimVector.call_args.commitment);
const destination = process.env.DEMO_DESTINATION ?? 'alice.testnet';
const NETWORK = process.env.NETWORK ?? 'testnet';

// ---- dry mode: a mock NEAR RPC that verifies the claim tx like the chain would (scripts/mock-near-rpc.mjs)
function dryRelayerKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { secret: `ed25519:${base58(Buffer.concat([seed, pub]))}`, publicKey: pub };
}

// Every call has a deadline, so a broken Worker fails the demo instead of hanging it.
const call = (worker, path, body) => worker.fetch(path, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });

const viewOn = async (rpcUrl, contractId, method, args) => {
  const res = await fetch(rpcUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'demo', method: 'query', params: { request_type: 'call_function', finality: 'optimistic', account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }),
  });
  const body = await res.json();
  if (!body.result?.result) throw new Error(`view ${method}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
  return JSON.parse(Buffer.from(body.result.result).toString());
};

async function main() {
  // A sandbox run must never report a mocked pass.
  if (process.env.DEMO_REQUIRE_RPC === '1' && (dry || !process.env.NEAR_RPC_URL)) return fail('sandbox exports missing');
  const workers = [];
  let mock;
  try {
    step(1, dry ? 'NEAR RPC: mocked (--dry)' : 'NEAR RPC: sandbox from env');
    const contractId = process.env.CONTRACT_ID ?? (dry ? 'zarf-near.test.near' : undefined);
    let rpcUrl = process.env.NEAR_RPC_URL;
    let relayerKey = process.env.RELAYER_KEY;
    if (dry) {
      const k = dryRelayerKey();
      relayerKey = k.secret;
      const ctx = { contractId, network: NETWORK, relayerPublicKey: k.publicKey, verifierSigner: vectors.keys.signer, merkleRoot: campaign.merkle_root };
      mock = await startMockRpc(ctx, campaign, console.log);
      rpcUrl = mock.url;
    }
    const relayerAccount = process.env.RELAYER_ACCOUNT_ID ?? (dry ? 'relayer.test.near' : undefined);
    const campaignId = process.env.DEMO_CAMPAIGN_ID ?? (dry ? campaign.campaign_id : undefined);
    const missing = Object.entries({ NEAR_RPC_URL: rpcUrl, CONTRACT_ID: contractId, RELAYER_ACCOUNT_ID: relayerAccount, RELAYER_KEY: relayerKey, DEMO_CAMPAIGN_ID: campaignId }).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) return fail(`set ${missing.join(', ')} (see the header of scripts/demo.mjs), or run with --dry`);
    console.log(`      rpc ${rpcUrl}, contract ${contractId}, campaign ${campaignId} (${which}), relayer ${relayerAccount}`);

    step(2, 'start the verifier (demo build: throwaway issuer, never deployed) and the relayer');
    const verifier = await unstable_dev(`${root}verifier/src/demo.ts`, {
      config: `${root}verifier/wrangler.demo.jsonc`, ip: '127.0.0.1', logLevel: 'warn',
      vars: { CONTRACT_ID: contractId, NEAR_RPC_URL: rpcUrl, SIGNER_SEED: vectors.keys.signer_seed },
      experimental: { disableExperimentalWarning: true },
    });
    workers.push(verifier);
    process.env.RELAYER_KEY = relayerKey; // wrangler checks required secrets against the environment
    const relayer = await unstable_dev(`${root}relayer/src/index.ts`, {
      config: `${root}relayer/wrangler.jsonc`, ip: '127.0.0.1', logLevel: 'warn',
      vars: { NETWORK, CONTRACT_ID: contractId, RELAYER_ACCOUNT_ID: relayerAccount, NEAR_RPC_URL: rpcUrl, VERIFIER_SIGNERS: vectors.keys.signer, RELAYER_KEY: relayerKey },
      experimental: { disableExperimentalWarning: true },
    });
    workers.push(relayer);
    console.log(`      verifier http://${verifier.address}:${verifier.port}, relayer http://${relayer.address}:${relayer.port}`);

    step(3, `"sign in": demo token for ${recipient.canonical_email}, nonce = sha256(${destination})`);
    const tokenRes = await call(verifier, '/demo/token', { email: recipient.email, destination });
    if (tokenRes.status !== 200) return fail(`demo issuer answered ${tokenRes.status} ${await tokenRes.text()}`);
    const { id_token } = await tokenRes.json();
    console.log(`      nonce ${createHash('sha256').update(destination).digest('hex')}`);

    step(4, 'verifier: check token, commitment (salt from the claim link), proof and chain state; sign');
    const vRes = await call(verifier, '/claim', {
      id_token, campaign_id: campaignId, commitment: recipient.commitment, amount: recipient.amount, proof: claimVector.call_args.proof, destination, salt: recipient.salt,
    });
    const signed = await vRes.json();
    if (vRes.status !== 200) return fail(`verifier answered ${vRes.status} ${JSON.stringify(signed)}`);
    console.log(`      signed by ${signed.signer}, expires_at_ns ${signed.expires_at_ns}`);

    step(5, 'relayer: submit claim with its claim-only key');
    const rRes = await call(relayer, '/claim', signed);
    const relayed = await rRes.json();
    if (rRes.status !== 200 && rRes.status !== 202) return fail(`relayer answered ${rRes.status} ${JSON.stringify(relayed)}`);
    console.log(`      tx ${relayed.tx_hash} (${relayed.status})`);

    step(6, 'chain: claim_state must be "claimed"');
    let state;
    for (let i = 0; i < 30; i++) {
      state = await viewOn(rpcUrl, contractId, 'claim_state', { campaign_id: campaignId, commitment: recipient.commitment });
      if (state !== 'pending') break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (state !== 'claimed') return fail(`claim_state is ${state}`);
    console.log(`      claim_state = claimed\n\nDEMO PASSED${dry ? ' (mocked RPC: the contract side is not exercised)' : ''}`);
  } finally {
    await Promise.all(workers.map((w) => w.stop()));
    mock?.close();
  }
}

main().catch((e) => fail(e.stack ?? String(e)));
