import { describe, expect, it } from 'vitest';
import vectors from '../../../spec/vectors.json';
import { proofFor } from './merkle';

const leavesOf = (name: keyof typeof vectors.campaigns) =>
  vectors.campaigns[name].recipients.map((r) => ({ commitment: r.commitment, amount: r.amount }));

describe('proofFor (from the published leaf list)', () => {
  it.each(vectors.claims.valid)('reproduces the proof and root of $name', async (c) => {
    const name = c.campaign as keyof typeof vectors.campaigns;
    const got = await proofFor(leavesOf(name), c.call_args.commitment);
    expect(got).toEqual({ amount: c.call_args.amount, proof: c.call_args.proof, root: vectors.campaigns[name].merkle_root });
  });
  it('returns null for a commitment not in the list', async () => {
    expect(await proofFor(leavesOf('main'), '00'.repeat(32))).toBeNull();
  });
});
