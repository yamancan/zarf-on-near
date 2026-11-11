// The --dry stand-in for a NEAR node + the escrow contract, for one demo claim. It checks what the
// real chain would, so a signing regression makes the demo fail instead of passing quietly:
// the relayer's tx signature (by the key it was given), the call shape (our contract, `claim`,
// deposit 0), the verifier's ed25519 signature over the rebuilt payload, and the merkle proof.
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const { decodeSignedTransaction } = await import(`${root}relayer/node_modules/@near-js/transactions/lib/esm/index.js`);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export const base58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  for (; n > 0n; n /= 58n) out = B58[Number(n % 58n)] + out;
  for (const b of bytes) { if (b) break; out = '1' + out; }
  return out;
};

const sha256 = (...parts) => createHash('sha256').update(Buffer.concat(parts)).digest();
const edKey = (raw) => createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
const str = (s) => Buffer.concat([Buffer.from([Buffer.byteLength(s)]), Buffer.from(s)]);
const le = (v, n) => { const b = Buffer.alloc(n); let x = BigInt(v); for (let i = 0; i < n; i++, x >>= 8n) b[i] = Number(x & 0xffn); return b; };
export const claimPayload = (network, contractId, c) => Buffer.concat([
  Buffer.from('ZARF-NEAR-CLAIM-V1'), str(network), str(contractId), le(c.campaign_id, 8),
  Buffer.from(c.commitment, 'hex'), le(c.amount, 16), str(c.destination), le(c.expires_at_ns, 8),
]);
const node = (a, b) => (Buffer.compare(a, b) <= 0 ? sha256(Buffer.from([1]), a, b) : sha256(Buffer.from([1]), b, a));

/**
 * Checks one submitted `claim` tx; returns its args or throws with the reason.
 * ctx: { contractId, network, relayerPublicKey (32 bytes), verifierSigner (hex), merkleRoot (hex) }
 */
export function verifyClaimTx(signedTxBase64, ctx) {
  const bytes = Buffer.from(signedTxBase64, 'base64');
  const { transaction: tx, signature } = decodeSignedTransaction(bytes);
  const txPub = Buffer.from(tx.publicKey.ed25519Key.data);
  if (!txPub.equals(Buffer.from(ctx.relayerPublicKey))) throw new Error('tx signed with an unexpected key');
  const digest = sha256(bytes.subarray(0, bytes.length - 65)); // SignedTransaction = tx || keyType || sig(64)
  if (!edVerify(null, digest, edKey(txPub), Buffer.from(signature.ed25519Signature.data))) throw new Error('bad tx signature');
  const fc = tx.actions[0]?.functionCall;
  if (tx.actions.length !== 1 || !fc || tx.receiverId !== ctx.contractId || fc.methodName !== 'claim' || fc.deposit !== 0n) {
    throw new Error('not a single zero-deposit claim call on our contract');
  }
  const args = JSON.parse(Buffer.from(Object.values(fc.args)).toString());
  if (args.signer !== ctx.verifierSigner) throw new Error('claim signed by an unregistered signer');
  const payload = claimPayload(ctx.network, ctx.contractId, args);
  if (!edVerify(null, payload, edKey(Buffer.from(args.signer, 'hex')), Buffer.from(args.signature, 'hex'))) throw new Error('E101_INVALID_SIGNATURE');
  const leaf = sha256(Buffer.from([0]), Buffer.from(args.commitment, 'hex'), le(args.amount, 16));
  const reached = args.proof.reduce((h, p) => node(h, Buffer.from(p, 'hex')), leaf);
  if (reached.toString('hex') !== ctx.merkleRoot) throw new Error('E102_INVALID_MERKLE_PROOF');
  return args;
}

/** A NEAR JSON-RPC server for the contract's views and one claim; claim_state flips to claimed only after a verified tx. */
export async function startMockRpc(ctx, campaign, log = () => {}) {
  const state = new Map();
  const view = (o) => ({ result: [...Buffer.from(JSON.stringify(o))] });
  const far = '9'.repeat(19);
  const views = {
    get_network: () => ctx.network,
    get_campaign: () => ({ merkle_root: ctx.merkleRoot, deadline_ns: far, balance: campaign.recipients.reduce((t, r) => t + BigInt(r.amount), 0n).toString(), policy: 'owner', snapshot: [ctx.verifierSigner] }),
    claim_state: (a) => state.get(a.commitment) ?? 'unclaimed',
    get_agent: () => ({ kind: 'owner', valid_until_ns: far }),
    required_claim_gas: () => '150000000000000',
  };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const { method, params, id } = JSON.parse(body);
    const reply = (o) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id, ...o }));
    if (method === 'query' && params.request_type === 'call_function') {
      return reply({ result: view(views[params.method_name](JSON.parse(Buffer.from(params.args_base64, 'base64').toString()))) });
    }
    if (method === 'query' && params.request_type === 'view_access_key') {
      return reply({ result: { nonce: 1, block_hash: base58(new Uint8Array(32).fill(1)), permission: { FunctionCall: { receiver_id: ctx.contractId, method_names: ['claim'], allowance: null } } } });
    }
    if (method === 'send_tx') {
      let args;
      try {
        args = verifyClaimTx(params.signed_tx_base64, ctx);
      } catch (e) {
        log(`      mock RPC: REFUSED claim tx: ${e.message}`);
        const failure = { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${e.message}` } } } };
        return reply({ result: { status: { Failure: failure }, receipts_outcome: [] } });
      }
      state.set(args.commitment, 'claimed');
      log(`      mock RPC: verified tx signature, verifier signature and merkle proof; claim paid`);
      const event = { standard: 'zarf-near', version: '1.0.0', event: 'claim_paid', data: [{ campaign_id: args.campaign_id, commitment: args.commitment, amount: args.amount, destination: args.destination }] };
      return reply({ result: { status: { SuccessValue: '' }, receipts_outcome: [{ outcome: { executor_id: ctx.contractId, logs: [`EVENT_JSON:${JSON.stringify(event)}`] } }] } });
    }
    res.writeHead(400).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}
