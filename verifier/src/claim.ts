// Byte formats from spec/claim.md v2. Every function here is pinned by spec/vectors.json.

const enc = new TextEncoder();

export const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export function unhex(s: string, len?: number): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/.test(s) || (len !== undefined && s.length !== len * 2)) throw new Error('bad hex');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

function uintLe(value: string, bytes: number): Uint8Array {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) throw new Error('bad integer');
  let v = BigInt(value);
  if (v >> BigInt(bytes * 8)) throw new Error('integer out of range');
  const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++, v >>= 8n) out[i] = Number(v & 0xffn);
  return out;
}

function lenPrefixed(s: string): Uint8Array {
  const b = enc.encode(s);
  if (b.length > 255) throw new Error('string longer than 255 bytes');
  return concat(Uint8Array.of(b.length), b);
}

const sha256 = async (b: BufferSource) => new Uint8Array(await crypto.subtle.digest('SHA-256', b));

/**
 * spec v2: trim ASCII whitespace, require printable ASCII, then lowercase. No dot/plus folding: the
 * commitment must match Google's literal `email` claim. The ASCII check runs before lowercasing
 * because U+212A (Kelvin sign) lowercases to an ASCII 'k'.
 */
export function canonicalizeEmail(email: string): string {
  const t = email.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  if (!/^[\x21-\x7e]+$/.test(t)) throw new Error('email must be printable ASCII');
  return t.toLowerCase();
}

export const destinationNonce = async (destination: string): Promise<string> => hex(await sha256(enc.encode(destination)));

export async function commitment(salt: BufferSource, email: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(canonicalizeEmail(email))));
}

export interface ClaimArgs {
  network: string;
  contract_id: string;
  campaign_id: string; // u64, decimal
  commitment: string; // hex32
  amount: string; // u128, decimal
  destination: string;
  expires_at_ns: string; // u64, decimal
}

export const claimPayload = (a: ClaimArgs): Uint8Array<ArrayBuffer> =>
  concat(
    enc.encode('ZARF-NEAR-CLAIM-V1'),
    lenPrefixed(a.network),
    lenPrefixed(a.contract_id),
    uintLe(a.campaign_id, 8),
    unhex(a.commitment, 32),
    uintLe(a.amount, 16),
    lenPrefixed(a.destination),
    uintLe(a.expires_at_ns, 8),
  );

// Fixed PKCS#8 headers turn a raw 32-byte seed into an importable private key.
const pkcs8 = (prefix: string, seed: Uint8Array) => concat(unhex(prefix), seed);

export interface Signer {
  key: CryptoKey;
  signer: string; // hex of the ed25519 public key, as the contract's registry names it
}

export async function importSigner(seedHex: string): Promise<Signer> {
  const der = pkcs8('302e020100300506032b657004220420', unhex(seedHex, 32));
  // Extractable once, only to read the public half (JWK `x`).
  const { x } = await crypto.subtle.exportKey('jwk', await crypto.subtle.importKey('pkcs8', der, 'Ed25519', true, ['sign']));
  const pub = Uint8Array.from(atob(x!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  return { key: await crypto.subtle.importKey('pkcs8', der, 'Ed25519', false, ['sign']), signer: hex(pub) };
}

export const signClaim = async (key: CryptoKey, args: ClaimArgs): Promise<string> =>
  hex(await crypto.subtle.sign('Ed25519', key, claimPayload(args)));
