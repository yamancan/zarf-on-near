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
//   DEMO_VECTOR_CAMPAIGN "main" (alice@example.com, default) or "single" (solo@example.com)
//   DEMO_DESTINATION     account that receives the tokens (default alice.testnet)
// The demo verifier signs with spec/vectors.json keys.signer_seed: a public test key, sandbox only.

import { createRequire } from 'node:module';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const { unstable_dev } = require(`${root}relayer/node_modules/wrangler`);
const vectors = JSON.parse(readFileSync(`${root}spec/vectors.json`, 'utf8'));

const dry = process.argv.includes('--dry');
const step = (n, msg) => console.log(`\n[${n}] ${msg}`);
const fail = (msg) => {
  console.error(`\nDEMO FAILED: ${msg}`);
  process.exitCode = 1;
};

// ---- which claim ------------------------------------------------------------------------------
const which = process.env.DEMO_VECTOR_CAMPAIGN ?? 'main';
const campaign = vectors.campaigns[which];
const claimVector = vectors.claims.valid.find((c) => c.campaign === which);
if (!campaign || !claimVector) throw new Error(`no vector campaign "${which}"`);
const recipient = campaign.recipients.find((r) => r.commitment === claimVector.call_args.commitment);
const destination = process.env.DEMO_DESTINATION ?? 'alice.testnet';
const NETWORK = process.env.NETWORK ?? 'testnet';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const base58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) { if (b) break; out = '1' + out; }
  return out;
};

// ---- dry mode: a NEAR RPC that behaves like the contract for this one claim --------------------
async function startMockRpc(contractId) {
  const { decodeSignedTransaction } = await import(`${root}relayer/node_modules/@near-js/transactions/lib/esm/index.js`);
  const state = new Map(); // commitment -> claim_state
  const view = (o) => ({ result: [...Buffer.from(JSON.stringify(o))] });
  const far = '9'.repeat(19);
  const views = {
    get_network: () => NETWORK,
    get_campaign: () => ({ merkle_root: campaign.merkle_root, deadline_ns: far, balance: campaign.recipients.reduce((t, r) => t + BigInt(r.amount), 0n).toString(), policy: 'owner', snapshot: [vectors.keys.signer] }),
    claim_state: (a) => state.get(a.commitment) ?? 'unclaimed',
    get_agent: () => ({ kind: 'owner', valid_until_ns: far }),
    required_claim_gas: () => '150000000000000',
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { method, params, id } = JSON.parse(body);
    let result;
    if (method === 'query' && params.request_type === 'call_function') {
      result = view(views[params.method_name](JSON.parse(Buffer.from(params.args_base64, 'base64').toString())));
    } else if (method === 'query' && params.request_type === 'view_access_key') {
      result = { nonce: 1, block_hash: base58(new Uint8Array(32).fill(1)), permission: { FunctionCall: { receiver_id: contractId, method_names: ['claim'], allowance: null } } };
    } else if (method === 'send_tx') {
      const tx = decodeSignedTransaction(Buffer.from(params.signed_tx_base64, 'base64')).transaction;
      const fc = tx.actions[0].functionCall;
      const args = JSON.parse(Buffer.from(Object.values(fc.args)).toString());
      if (tx.receiverId !== contractId || fc.methodName !== 'claim' || fc.deposit !== 0n) throw new Error('mock RPC: unexpected tx');
      state.set(args.commitment, 'claimed');
      const event = { standard: 'zarf-near', version: '1.0.0', event: 'claim_paid', data: [{ campaign_id: args.campaign_id, commitment: args.commitment, amount: args.amount, destination: args.destination }] };
      result = { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { executor_id: contractId, logs: [`EVENT_JSON:${JSON.stringify(event)}`] } }] };
      console.log(`      mock RPC: claim tx from ${tx.signerId} -> ${tx.receiverId}.claim, gas ${fc.gas}, deposit ${fc.deposit}`);
    } else {
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

function dryRelayerKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return `ed25519:${base58(Buffer.concat([seed, pub]))}`;
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
  const workers = [];
  let mock;
  try {
    step(1, dry ? 'NEAR RPC: mocked (--dry)' : 'NEAR RPC: sandbox from env');
    const contractId = process.env.CONTRACT_ID ?? (dry ? 'zarf-near.test.near' : undefined);
    let rpcUrl = process.env.NEAR_RPC_URL;
    if (dry) {
      mock = await startMockRpc(contractId);
      rpcUrl = mock.url;
    }
    const relayerAccount = process.env.RELAYER_ACCOUNT_ID ?? (dry ? 'relayer.test.near' : undefined);
    const relayerKey = process.env.RELAYER_KEY ?? (dry ? dryRelayerKey() : undefined);
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
