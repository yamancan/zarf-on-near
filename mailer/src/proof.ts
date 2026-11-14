// The claim-link math, byte for byte as web/src/lib/create/campaign.ts, web/src/lib/merkle.ts and web/src/lib/claim.ts
// (spec/claim.md). The mailer recomputes it so it only ever emails a leaf that is really in a funded campaign.

export const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

/** web/src/lib/create/recipients.ts canonicalEmail: trimmed, printable ASCII only, lower case. */
export function canonicalEmail(email: string): string {
  const t = email.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!/^[\x21-\x7e]+$/.test(t)) throw new Error('not ASCII');
  return t.toLowerCase();
}
/** web/src/lib/create/recipients.ts ADDR_SPEC (on the canonical form). */
export const ADDR_SPEC = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export async function commitment(saltHex: string, email: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', unhex(saltHex), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonicalEmail(email))));
}

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
const leafHash = (commitmentHex: string, amount: string) => sha256(Uint8Array.of(0), unhex(commitmentHex), u128le(amount));
const nodeHash = (a: Uint8Array, b: Uint8Array) => (lessOrEqual(a, b) ? sha256(Uint8Array.of(1), a, b) : sha256(Uint8Array.of(1), b, a));

/** spec: h = leaf; for s in proof: h = node(h, s). */
export async function rootFromProof(commitmentHex: string, amount: string, proof: string[]): Promise<string> {
  let h = await leafHash(commitmentHex, amount);
  for (const s of proof) h = await nodeHash(h, unhex(s));
  return hex(h);
}

/** web/src/lib/claim.ts encodeProof: base64url of the concatenated siblings, no padding. */
export function encodeProof(proof: string[]): string {
  const bytes = Uint8Array.from(proof.join('').match(/../g) ?? [], (x) => parseInt(x, 16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** web/src/lib/create/campaign.ts claimLink: `<origin>/claim/<id>/<commitment>#s=<salt>&a=<amount>&p=<proof>`. */
export const claimLink = (origin: string, campaignId: string, l: { commitment: string; salt: string; amount: string; proof: string[] }) =>
  `${origin}/claim/${campaignId}/${l.commitment}#s=${l.salt}&a=${l.amount}&p=${encodeProof(l.proof)}`;
