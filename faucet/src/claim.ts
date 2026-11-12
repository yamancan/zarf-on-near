// Byte rules from spec/claim.md (v2.1); tests pin them to spec/vectors.json.

const enc = new TextEncoder();

export const hex = (b: ArrayBuffer | Uint8Array): string =>
  Array.from(b instanceof Uint8Array ? b : new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');

export function unhex(s: string, len: number): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/.test(s) || s.length !== len * 2) throw new Error('bad hex');
  return Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
}

/**
 * spec: trim only ASCII space/tab/CR/LF, then refuse unless every byte is 0x21..0x7e BEFORE
 * lowercasing (so U+212A KELVIN SIGN cannot lowercase into "k"), then lowercase. Null = refused.
 */
export function canonicalizeEmail(email: string): string | null {
  const t = email.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '');
  return /^[\x21-\x7e]+$/.test(t) ? t.toLowerCase() : null;
}

export async function commitment(salt: Uint8Array<ArrayBuffer>, canonicalEmail: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(canonicalEmail)));
}

/** leaf = sha256(0x00 || commitment || amount_u128_le). A one-leaf tree's root is its leaf. */
export async function leaf(commitmentHex: string, amount: string): Promise<string> {
  let v = BigInt(amount);
  if (v <= 0n || v >> 128n) throw new Error('amount out of range');
  const buf = new Uint8Array(49);
  buf.set(unhex(commitmentHex, 32), 1);
  for (let i = 33; i < 49; i++, v >>= 8n) buf[i] = Number(v & 0xffn);
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

/**
 * spec: `https://<claim-host>/claim/<campaign_id>/<commitment>#s=<salt_hex>&a=<amount>&p=<proof>`.
 * The faucet builds only one-leaf trees, so `p` (base64url of the concatenated siblings) is empty.
 * The fragment never reaches a server.
 */
export const claimLink = (host: string, campaignId: string, commitmentHex: string, saltHex: string, amount: string): string =>
  `${host.replace(/\/+$/, '')}/claim/${campaignId}/${commitmentHex}#s=${saltHex}&a=${amount}&p=`;
