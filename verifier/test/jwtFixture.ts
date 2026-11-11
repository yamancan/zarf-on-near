// Self-signed RSA keys stand in for Google's: no network, no real tokens.
const RSA = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' };
export const b64url = (b: Uint8Array | string) =>
  btoa(String.fromCharCode(...(typeof b === 'string' ? new TextEncoder().encode(b) : b)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export interface TestIssuer { kid: string; key: CryptoKey; jwk: JsonWebKey }
export async function testIssuer(kid: string): Promise<TestIssuer> {
  const kp = await crypto.subtle.generateKey(RSA, true, ['sign', 'verify']);
  return { kid, key: kp.privateKey, jwk: { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid, alg: 'RS256', use: 'sig' } as JsonWebKey };
}
export async function sign(s: TestIssuer, payload: object, header: object = { alg: 'RS256', kid: s.kid, typ: 'JWT' }) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', s.key, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}
export const jwksResponse = (...signers: TestIssuer[]) => new Response(JSON.stringify({ keys: signers.map((s) => s.jwk) }));

