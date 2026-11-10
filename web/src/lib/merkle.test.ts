import { describe, expect, it } from 'vitest';
import vectors from '../../../spec/vectors.json';
import { buildTree, rootFromProof } from './merkle';

const leavesOf = (name: keyof typeof vectors.campaigns) =>
  vectors.campaigns[name].recipients.map((r) => ({ commitment: r.commitment, amount: r.amount }));

describe('buildTree (create app)', () => {
  it.each(Object.keys(vectors.campaigns) as (keyof typeof vectors.campaigns)[])('%s: spec root', async (name) => {
    expect((await buildTree(leavesOf(name))).root).toBe(vectors.campaigns[name].merkle_root);
  });
  it.each(vectors.claims.valid)('gives the spec proof for $name', async (c) => {
    const name = c.campaign as keyof typeof vectors.campaigns;
    const i = vectors.campaigns[name].recipients.findIndex((r) => r.commitment === c.call_args.commitment);
    expect((await buildTree(leavesOf(name))).proofs[i]).toEqual(c.call_args.proof);
  });
  it('refuses an empty tree', async () => {
    await expect(buildTree([])).rejects.toThrow();
  });
});

describe('rootFromProof (claim app)', () => {
  it.each(vectors.claims.valid)('rebuilds the campaign root for $name', async (c) => {
    const name = c.campaign as keyof typeof vectors.campaigns;
    expect(await rootFromProof(c.call_args.commitment, c.call_args.amount, c.call_args.proof)).toBe(vectors.campaigns[name].merkle_root);
  });
  it('a changed amount or sibling gives another root (LINK_MISMATCH)', async () => {
    const c = vectors.claims.valid.find((v) => v.campaign === 'main')!.call_args;
    const root = vectors.campaigns.main.merkle_root;
    expect(await rootFromProof(c.commitment, (BigInt(c.amount) + 1n).toString(), c.proof)).not.toBe(root);
    expect(await rootFromProof(c.commitment, c.amount, ['00'.repeat(32), ...c.proof.slice(1)])).not.toBe(root);
    expect(await rootFromProof(c.commitment, c.amount, c.proof.slice(1))).not.toBe(root);
  });
});
