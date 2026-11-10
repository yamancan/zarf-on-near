// spec/claim.md merkle tree: the create app builds it (root + every proof); the claim app rebuilds
// the root from the one leaf and proof in its link.

import { hex } from './claim';

export interface Leaf {
  commitment: string; // hex32
  amount: string; // u128, decimal
}

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const sha256 = async (...parts: Uint8Array[]): Promise<Uint8Array> => {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
};

function u128le(amount: string): Uint8Array {
  const out = new Uint8Array(16);
  let v = BigInt(amount);
  for (let i = 0; i < 16; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

function lessOrEqual(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return true;
}

const leafHash = (l: Leaf) => sha256(Uint8Array.of(0), unhex(l.commitment), u128le(l.amount));
const nodeHash = (a: Uint8Array, b: Uint8Array) => (lessOrEqual(a, b) ? sha256(Uint8Array.of(1), a, b) : sha256(Uint8Array.of(1), b, a));

/** The root and, for every leaf in order, its proof (siblings leaf → root; a carried-up odd tail has none). */
export async function buildTree(leaves: Leaf[]): Promise<{ root: string; proofs: string[][] }> {
  if (!leaves.length) throw new Error('a tree has at least one leaf');
  const proofs: string[][] = leaves.map(() => []);
  let level = await Promise.all(leaves.map(leafHash));
  let index = leaves.map((_, i) => i); // each leaf's position on the current level
  while (level.length > 1) {
    const at = level;
    index.forEach((pos, leaf) => {
      const sib = pos ^ 1;
      if (sib < at.length) proofs[leaf].push(hex(at[sib]));
    });
    const next: Promise<Uint8Array>[] = [];
    for (let i = 0; i < at.length; i += 2) next.push(i + 1 < at.length ? nodeHash(at[i], at[i + 1]) : Promise.resolve(at[i]));
    level = await Promise.all(next);
    index = index.map((pos) => pos >> 1);
  }
  return { root: hex(level[0]), proofs };
}

/** spec: h = leaf; for s in proof: h = node(h, s). The claim app compares this with get_campaign's root. */
export async function rootFromProof(commitment: string, amount: string, proof: string[]): Promise<string> {
  let h = await leafHash({ commitment, amount });
  for (const s of proof) h = await nodeHash(h, unhex(s));
  return hex(h);
}
