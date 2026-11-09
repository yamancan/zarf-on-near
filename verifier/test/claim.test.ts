import { describe, expect, it } from 'vitest';
import vectors from '../../spec/vectors.json';
import {
  canonicalizeEmail, claimPayload, commitment, destinationNonce, hex, importSealKey, importVerifierKey,
  signClaim, unhex, unsealSalt,
} from '../src/claim';

const { keys, campaign, claims } = vectors;

describe('spec/vectors.json', () => {
  it('is not empty', () => {
    expect(campaign.recipients.length).toBeGreaterThanOrEqual(1);
    expect(claims.valid.length).toBeGreaterThanOrEqual(3);
    expect(claims.invalid.length).toBeGreaterThanOrEqual(1);
  });

  it.each(campaign.recipients)('commitment for $email', async (r) => {
    expect(canonicalizeEmail(r.email)).toBe(r.canonical_email);
    expect(hex(await commitment(unhex(campaign.salt), r.email))).toBe(r.commitment);
  });

  it.each(claims.valid)('nonce, payload and signature: $name', async (c) => {
    expect(await destinationNonce(c.args.destination)).toBe(c.nonce);
    expect(hex(claimPayload(c.args))).toBe(c.payload);
    expect(await signClaim(await importVerifierKey(keys.verifier_seed), c.args)).toBe(c.signature);
  });

  // E101 vectors carry a signature over other bytes; E102 ones are honestly signed and fail only the merkle check.
  it.each(claims.invalid)('invalid vector $name ($expect)', async (c) => {
    expect(hex(claimPayload(c.args))).toBe(c.payload);
    const ours = await signClaim(await importVerifierKey(keys.verifier_seed), c.args);
    if (c.expect === 'E101_INVALID_SIGNATURE') expect(ours).not.toBe(c.signature);
    else expect(ours).toBe(c.signature);
  });

  it('unseals the campaign salt', async () => {
    const seal = await importSealKey(keys.seal_seed);
    expect(hex(seal.publicKey)).toBe(keys.seal_pubkey);
    expect(hex(await unsealSalt(campaign.sealed_salt, seal, campaign.merkle_root))).toBe(campaign.salt);
  });

  it('refuses a sealed salt presented with another merkle root', async () => {
    const seal = await importSealKey(keys.seal_seed);
    await expect(unsealSalt(campaign.sealed_salt, seal, '00'.repeat(32))).rejects.toThrow();
  });

  it('nonce known answer: sha256("abc")', async () => {
    expect(await destinationNonce('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('payload encoding guards', () => {
  const args = claims.valid[0].args;
  it.each([
    ['amount above u128', { amount: (1n << 128n).toString() }],
    ['negative campaign id', { campaign_id: '-1' }],
    ['non-decimal expiry', { expires_at_ns: '0x10' }],
    ['short commitment', { commitment: 'ab' }],
    ['uppercase hex commitment', { commitment: args.commitment.toUpperCase() }],
    ['destination over 255 bytes', { destination: 'a'.repeat(256) }],
  ])('throws on %s', (_, patch) => {
    expect(() => claimPayload({ ...args, ...patch })).toThrow();
  });
});
