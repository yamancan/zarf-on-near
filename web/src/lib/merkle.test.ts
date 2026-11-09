import { describe, expect, it } from 'vitest';
import vectors from '../../../spec/vectors.json';
import { checkedProof, proofFor } from './merkle';
import { ClaimError } from './services';

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

describe('checkedProof (list vs on-chain root)', () => {
  const main = vectors.campaigns.main;
  const c = vectors.claims.valid.find((v) => v.campaign === 'main')!.call_args;
  const list = () => ({ campaign_id: main.campaign_id, merkle_root: main.merkle_root, leaves: leavesOf('main') });
  const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof ClaimError ? e.code : String(e)));

  it('returns amount and proof when the list rebuilds the chain root', async () => {
    expect(await checkedProof(list(), main.merkle_root, c.commitment)).toEqual({ amount: c.amount, proof: c.proof });
  });
  it('refuses a list whose leaves were tampered with', async () => {
    const l = list();
    l.leaves[l.leaves.length - 1] = { ...l.leaves[l.leaves.length - 1], amount: '999999999' };
    expect(await code(checkedProof(l, main.merkle_root, c.commitment))).toBe('LEAVES_ROOT_MISMATCH');
  });
  it('refuses when the chain holds another root', async () => {
    expect(await code(checkedProof(list(), '00'.repeat(32), c.commitment))).toBe('LEAVES_ROOT_MISMATCH');
  });
  it('refuses a file whose declared root differs from the chain', async () => {
    expect(await code(checkedProof({ ...list(), merkle_root: '00'.repeat(32) }, main.merkle_root, c.commitment))).toBe('LEAVES_ROOT_MISMATCH');
  });
  it('refuses a commitment not in the list', async () => {
    expect(await code(checkedProof(list(), main.merkle_root, '11'.repeat(32)))).toBe('NOT_IN_LIST');
  });
});
