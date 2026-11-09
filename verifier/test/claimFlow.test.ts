import { beforeAll, describe, expect, it, vi } from 'vitest';
import vectors from '../../spec/vectors.json';
import type { ChainReader } from '../src/chain';
import { destinationNonce, hex, importSigner, isValidAccountId, leafHash, verifyMerkleProof, type Signer } from '../src/claim';
import { handleClaim, type ClaimDeps } from '../src/claimFlow';
import { remoteJwks } from '../src/jwks';
import { UpstreamError } from '../src/upstream';
import { jwksResponse, sign, testIssuer, type TestIssuer } from './jwtFixture';

const { keys, context, campaigns, claims } = vectors;
const NOW_MS = Number(BigInt(context.now_ns) / 1_000_000n);
const CLIENT_ID = 'client-123';
const named = claims.valid.find((c) => c.name === 'named-account')!;
const alice = campaigns.main.recipients.find((r) => r.commitment === named.call_args.commitment)!;

type ChainOver = Partial<{
  network: string; root: string; deadline: string; missing: boolean; balance: string;
  policy: 'owner' | 'attested'; snapshot: string[]; state: 'unclaimed' | 'pending' | 'claimed';
  agent: { valid_until_ns: string } | null;
}>;
const chain = (over: ChainOver = {}): ChainReader => ({
  getNetwork: async () => over.network ?? context.network,
  getCampaign: async (id) =>
    over.missing || id !== campaigns.main.campaign_id
      ? null
      : {
          merkle_root: over.root ?? campaigns.main.merkle_root,
          deadline_ns: over.deadline ?? context.deadline_ns,
          balance: over.balance ?? '1000000000',
          policy: over.policy ?? 'owner',
          snapshot: over.snapshot ?? [keys.signer],
        },
  claimState: async () => over.state ?? 'unclaimed',
  getAgent: async (id) => ('agent' in over ? over.agent! : id === keys.signer ? { valid_until_ns: context.deadline_ns } : null),
});

let google: TestIssuer, signer: Signer, deps: ClaimDeps;
const token = async (claimsOver: object = {}, destination = named.call_args.destination) =>
  sign(google, {
    iss: 'https://accounts.google.com', aud: CLIENT_ID, exp: NOW_MS / 1000 + 600,
    email: alice.email, email_verified: true, nonce: await destinationNonce(destination), ...claimsOver,
  });
const request = async (over: Record<string, unknown> = {}) => ({
  id_token: await token(),
  campaign_id: named.call_args.campaign_id,
  commitment: named.call_args.commitment,
  amount: named.call_args.amount,
  proof: named.call_args.proof,
  destination: named.call_args.destination,
  salt: alice.salt,
  ...over,
});

beforeAll(async () => {
  google = await testIssuer('k1');
  signer = await importSigner(keys.signer_seed);
  deps = { clientId: CLIENT_ID, contractId: context.contract_id, jwks: remoteJwks('x', async () => jwksResponse(google), () => NOW_MS), chain: chain(), signer, nowMs: NOW_MS };
});

describe('merkle', () => {
  it.each(Object.values(campaigns).flatMap((c) => c.recipients))('leaf for $email', async (r) => {
    expect(hex(await leafHash(r.commitment, r.amount))).toBe(r.leaf);
  });
  it.each(claims.valid)('valid proof reaches its root: $name', async (c) => {
    const root = campaigns[c.campaign as keyof typeof campaigns].merkle_root;
    expect(await verifyMerkleProof(await leafHash(c.call_args.commitment, c.call_args.amount), c.call_args.proof, root)).toBe(true);
  });
  it.each(claims.invalid)('$name: merkle result matches $expect', async (c) => {
    const ok = await verifyMerkleProof(await leafHash(c.call_args.commitment, c.call_args.amount), c.call_args.proof, campaigns.main.merkle_root);
    expect(ok).toBe(c.expect !== 'E102_INVALID_MERKLE_PROOF');
  });
  it('refuses a proof longer than 20 without hashing it', async () => {
    const c = named.call_args;
    const leaf = await leafHash(c.commitment, c.amount);
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      expect(await verifyMerkleProof(leaf, [...c.proof, ...Array(18).fill('00'.repeat(32))], campaigns.main.merkle_root)).toBe(false);
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });
  it('validates NEAR account ids', () => {
    for (const ok of ['alice.testnet', 'a'.repeat(64), 'my_wallet-2.near']) expect(isValidAccountId(ok)).toBe(true);
    for (const bad of ['a', 'Alice.testnet', 'alice..testnet', '.a', 'a.', 'a__b', 'x'.repeat(65)]) expect(isValidAccountId(bad)).toBe(false);
  });
});

describe('handleClaim', () => {
  it('signs the spec vector byte for byte and returns the contract claim args', async () => {
    const res = await handleClaim(await request(), deps);
    expect(res).toEqual({ status: 200, body: named.call_args });
  });

  it.each<[string, number, string, () => Promise<Record<string, unknown>>, Partial<ClaimDeps>?]>([
    ['bad destination, before the token is touched', 400, 'BAD_DESTINATION', () => request({ destination: 'Alice.testnet', id_token: 'x' })],
    ['salt not hex32', 400, 'E108_INVALID_INPUT', () => request({ salt: 'ab' })],
    ['proof over 20', 400, 'E108_INVALID_INPUT', () => request({ proof: Array(21).fill('00'.repeat(32)) })],
    ['proof entry not hex', 400, 'E108_INVALID_INPUT', () => request({ proof: ['zz'.repeat(32)] })],
    ['proof not an array', 400, 'E108_INVALID_INPUT', () => request({ proof: 'ab' })],
    ['commitment uppercase hex', 400, 'E108_INVALID_INPUT', () => request({ commitment: named.call_args.commitment.toUpperCase() })],
    ['salt with a non-hex char', 400, 'E108_INVALID_INPUT', () => request({ salt: 'g' + alice.salt.slice(1) })],
    ['campaign id above u64', 400, 'E108_INVALID_INPUT', () => request({ campaign_id: (1n << 64n).toString() })],
    ['amount 0', 400, 'E109_INVALID_AMOUNT', () => request({ amount: '0' })],
    ['amount above u128', 400, 'E109_INVALID_AMOUNT', () => request({ amount: (1n << 128n).toString() })],
    ['token for another destination', 401, 'BAD_NONCE', async () => request({ id_token: await token({}, 'bob.testnet') })],
    ['expired token', 401, 'EXPIRED', async () => request({ id_token: await token({ exp: NOW_MS / 1000 - 120 }) })],
    ['unknown campaign', 404, 'E110_UNKNOWN_CAMPAIGN', () => request(), { chain: chain({ missing: true }) }],
    ['one ns past the deadline', 409, 'E125_CAMPAIGN_ENDED', () => request(), { chain: chain({ deadline: (BigInt(context.now_ns) - 1n).toString() }) }],
    ['someone else\'s salt', 403, 'COMMITMENT_MISMATCH', () => request({ salt: campaigns.main.recipients[1].salt })],
    ['another email', 403, 'COMMITMENT_MISMATCH', async () => request({ id_token: await token({ email: 'mallory@example.com' }) })],
    ['amount not in the tree', 403, 'E102_INVALID_MERKLE_PROOF', () => request({ amount: '99' })],
    ['root from chain differs', 403, 'E102_INVALID_MERKLE_PROOF', () => request(), { chain: chain({ root: '00'.repeat(32) }) }],
    ['already claimed', 409, 'E105_ALREADY_CLAIMED', () => request(), { chain: chain({ state: 'claimed' }) }],
    ['transfer in flight', 409, 'E123_CLAIM_PENDING', () => request(), { chain: chain({ state: 'pending' }) }],
    ['our signer not in the owner snapshot', 403, 'E101_INVALID_SIGNATURE', () => request(), { chain: chain({ snapshot: [keys.rogue_signer] }) }],
    ['attested campaign, no measurement id (Mode W)', 403, 'E101_INVALID_SIGNATURE', () => request(), { chain: chain({ policy: 'attested', snapshot: ['ab'.repeat(32)] }) }],
    ['our key removed from the registry', 403, 'E101_INVALID_SIGNATURE', () => request(), { chain: chain({ agent: null }) }],
    ['our key expires before the signature', 403, 'E101_INVALID_SIGNATURE', () => request(), { chain: chain({ agent: { valid_until_ns: (BigInt(context.expires_at_ns) - 1n).toString() } }) }],
    ['amount missing', 400, 'E108_INVALID_INPUT', () => request({ amount: undefined })],
    ['balance below amount', 409, 'E129_INSUFFICIENT_BALANCE', () => request(), { chain: chain({ balance: (BigInt(named.call_args.amount) - 1n).toString() }) }],
  ])('refuses %s', async (_, status, error, make, over) => {
    expect(await handleClaim(await make(), { ...deps, ...over })).toEqual({ status, body: { error } });
  });

  it('ignores contract_id and network in the request: the payload uses config and chain', async () => {
    const res = await handleClaim(await request({ contract_id: 'evil.testnet', network: 'mainnet' }), deps);
    expect(res).toEqual({ status: 200, body: named.call_args }); // the vector is signed for zarf-near.testnet on testnet
  });

  it('a proof over 20 is refused before any token or hash work', async () => {
    const body = await request({ proof: Array(21).fill('00'.repeat(32)) }); // the fixture hashes the nonce; do it first
    const digest = vi.spyOn(crypto.subtle, 'digest');
    try {
      const res = await handleClaim(body, deps);
      expect(res.body).toEqual({ error: 'E108_INVALID_INPUT' });
      expect(digest).not.toHaveBeenCalled();
    } finally {
      digest.mockRestore();
    }
  });

  it('signs for an attested campaign when our measurement id is in its snapshot', async () => {
    const m = 'ab'.repeat(32);
    const res = await handleClaim(await request(), { ...deps, measurementId: m, chain: chain({ policy: 'attested', snapshot: [m] }) });
    expect(res).toEqual({ status: 200, body: named.call_args });
  });

  it('accepts our key expiring exactly at expires_at_ns', async () => {
    const res = await handleClaim(await request(), { ...deps, chain: chain({ agent: { valid_until_ns: context.expires_at_ns } }) });
    expect(res.status).toBe(200);
  });

  it('accepts a balance exactly equal to the amount', async () => {
    const res = await handleClaim(await request(), { ...deps, chain: chain({ balance: named.call_args.amount }) });
    expect(res.status).toBe(200);
  });

  it('accepts a claim exactly at the deadline (claim iff now <= deadline)', async () => {
    const res = await handleClaim(await request(), { ...deps, chain: chain({ deadline: context.now_ns }) });
    expect(res.status).toBe(200);
  });

  it('signs over the network read from chain, not a constant', async () => {
    const res = await handleClaim(await request(), { ...deps, chain: chain({ network: 'mainnet' }) });
    expect(res.status).toBe(200);
    expect(res.body.signature).not.toBe(named.call_args.signature);
  });

  it('fails closed when the chain read fails', async () => {
    const broken: ChainReader = { ...chain(), getNetwork: () => Promise.reject(new Error('rpc down')) };
    await expect(handleClaim(await request(), { ...deps, chain: broken })).rejects.toThrow(UpstreamError);
  });
});
