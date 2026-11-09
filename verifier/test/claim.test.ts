import { describe, expect, it } from 'vitest';
import vectors from '../../spec/vectors.json';
import { canonicalizeEmail, claimPayload, commitment, destinationNonce, hex, importSigner, signClaim, unhex } from '../src/claim';

const { keys, context, campaigns, claims } = vectors;
const recipients = Object.values(campaigns).flatMap((c) => c.recipients);
const argsOf = (c: (typeof claims.valid)[number]) => ({
  network: context.network,
  contract_id: context.contract_id,
  ...c.call_args,
});

describe('spec/vectors.json (v2)', () => {
  it('is not empty', () => {
    expect(recipients.length).toBeGreaterThanOrEqual(1);
    expect(claims.valid.length).toBeGreaterThanOrEqual(3);
    expect(claims.invalid.length).toBeGreaterThanOrEqual(1);
    expect(vectors.rejected_emails.length).toBeGreaterThanOrEqual(1);
  });

  it.each(recipients)('commitment for $email', async (r) => {
    expect(canonicalizeEmail(r.email)).toBe(r.canonical_email);
    expect(hex(await commitment(unhex(r.salt), r.email))).toBe(r.commitment);
  });

  it.each(vectors.rejected_emails)('refuses email %j', (e) => {
    expect(() => canonicalizeEmail(e)).toThrow('ASCII');
  });

  it('derives the registered signer from its seed', async () => {
    expect((await importSigner(keys.signer_seed)).signer).toBe(keys.signer);
  });

  it.each(claims.valid)('nonce, payload and signature: $name', async (c) => {
    const { key, signer } = await importSigner(keys.signer_seed);
    expect(await destinationNonce(c.call_args.destination)).toBe(c.nonce);
    expect(hex(claimPayload(argsOf(c)))).toBe(c.payload);
    expect(c.call_args.signer).toBe(signer);
    expect(await signClaim(key, argsOf(c))).toBe(c.call_args.signature);
  });

  // E101 vectors carry a signature over other bytes or from another key; E102 ones are honestly signed.
  it.each(claims.invalid)('invalid vector $name ($expect)', async (c) => {
    expect(hex(claimPayload(argsOf(c)))).toBe(c.payload);
    const ours = await signClaim((await importSigner(keys.signer_seed)).key, argsOf(c));
    if (c.expect === 'E101_INVALID_SIGNATURE') expect(ours === c.call_args.signature && c.call_args.signer === keys.signer).toBe(false);
    else expect(ours).toBe(c.call_args.signature);
  });

  it('nonce known answer: sha256("abc")', async () => {
    expect(await destinationNonce('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('payload encoding guards', () => {
  const args = argsOf(claims.valid[0]);
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
