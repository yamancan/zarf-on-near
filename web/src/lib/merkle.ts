// spec/claim.md merkle tree, built in the browser from the published leaf list to get a proof.

import { hex } from './claim';
import { ClaimError, type LeafList } from './services';

export interface Leaf {
  commitment: string; // hex32
  amount: string; // u128, decimal
}

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
const sha256 = async (...parts: Uint8Array[]) => {
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

/** The leaf for `commitment`, its proof, and the tree root; null if the commitment is not in the list. */
export async function proofFor(leaves: Leaf[], commitment: string): Promise<{ amount: string; proof: string[]; root: string } | null> {
  let index = leaves.findIndex((l) => l.commitment === commitment);
  if (index < 0) return null;
  const amount = leaves[index].amount;
  let level: Uint8Array[] = await Promise.all(leaves.map(leafHash));
  const proof: string[] = [];
  while (level.length > 1) {
    const sibling = index ^ 1;
    if (sibling < level.length) proof.push(hex(level[sibling])); // the odd tail is carried up: no sibling
    const next: Promise<Uint8Array>[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i], level[i + 1]) : Promise.resolve(level[i]));
    level = await Promise.all(next);
    index >>= 1;
  }
  return { amount, proof, root: hex(level[0]) };
}

/** Proof for `commitment` from a published list, refused unless the list rebuilds the root the contract holds. */
export async function checkedProof(list: LeafList, chainRoot: string, commitment: string): Promise<{ amount: string; proof: string[] }> {
  const found = await proofFor(list.leaves, commitment);
  if (!found) throw new ClaimError('NOT_IN_LIST');
  if (found.root !== chainRoot || list.merkle_root !== chainRoot) throw new ClaimError('LEAVES_ROOT_MISMATCH');
  return { amount: found.amount, proof: found.proof };
}
