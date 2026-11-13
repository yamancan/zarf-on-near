// The chains Zarf funds from and pays out to through NEAR Intents 1Click: one list, shared by the funding picker
// (create/fundIn.ts) and the payout picker (PayoutPicker.svelte). Each entry carries its id (`key`), name, logo,
// pinned USDC asset id and the address checks for that chain. The verifier pins the same ids (verifier/src/intents.ts).

import { keccak_256 } from '@noble/hashes/sha3';
import { hex } from './claim';
import { b58decode } from './oneclickSig';

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

// Chain marks: the "branded" network icons of @web3icons/core 4.0.59 (MIT, github.com/0xa3k5/web3icons), which
// reproduce each chain's own brand mark; width/height and the class attribute removed. Paths and gradients only.
const LOGOS: Record<string, string> = {
  base: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="#00F" d="M3 4.706c0-.585 0-.877.11-1.101.106-.215.28-.39.496-.495C3.83 3 4.122 3 4.706 3h14.588c.585 0 .876 0 1.101.11.215.105.389.28.494.495.111.225.111.517.111 1.101v14.588c0 .585 0 .876-.11 1.101-.106.215-.28.389-.495.494-.225.111-.517.111-1.101.111H4.706c-.585 0-.876 0-1.101-.11a1.08 1.08 0 0 1-.494-.495C3 20.17 3 19.878 3 19.294z"/></svg>',
  arb: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="#213147" d="M4.515 8.471v7.056c0 .45.245.867.64 1.092l6.205 3.529a1.3 1.3 0 0 0 1.28 0l6.203-3.53c.396-.224.64-.64.64-1.09V8.47c0-.45-.244-.867-.64-1.091L12.64 3.85a1.3 1.3 0 0 0-1.28 0L5.155 7.38a1.25 1.25 0 0 0-.639 1.091"/><path fill="#12AAFF" d="m13.353 13.368-.885 2.39a.3.3 0 0 0 0 .205l1.523 4.112 1.76-1.001-2.113-5.706a.152.152 0 0 0-.285 0m1.774-4.019a.152.152 0 0 0-.285 0l-.885 2.39a.3.3 0 0 0 0 .205l2.494 6.732 1.761-1.001z"/><path fill="#9DCCED" d="M11.998 4.115a.3.3 0 0 1 .126.033l6.715 3.818a.25.25 0 0 1 .126.214v7.635c0 .089-.048.17-.126.214l-6.715 3.819a.25.25 0 0 1-.126.032.3.3 0 0 1-.125-.032l-6.715-3.815a.25.25 0 0 1-.126-.215V8.182c0-.089.048-.17.126-.215l6.715-3.818a.26.26 0 0 1 .125-.034m0-1.115c-.238 0-.478.06-.692.183L4.593 7A1.36 1.36 0 0 0 3.9 8.182v7.635c0 .487.264.938.693 1.181l6.714 3.819a1.41 1.41 0 0 0 1.386 0l6.714-3.818a1.36 1.36 0 0 0 .693-1.182V8.182A1.36 1.36 0 0 0 19.407 7l-6.716-3.817A1.4 1.4 0 0 0 11.998 3"/><path fill="#213147" d="m7.559 18.685.617-1.666 1.244 1.018-1.163 1.046z"/><path fill="#fff" d="M11.433 7.635H9.731a.3.3 0 0 0-.285.197l-3.649 9.852 1.761 1.001 4.018-10.849a.15.15 0 0 0-.143-.2m2.979-.001h-1.703a.3.3 0 0 0-.284.197l-4.167 11.25 1.761 1 4.535-12.246a.15.15 0 0 0-.142-.2"/></svg>',
  eth: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="#8FFCF3" d="M12 3v6.651l5.625 2.516z"/><path fill="#CABCF8" d="m12 3-5.625 9.166L12 9.653z"/><path fill="#CBA7F5" d="M12 16.478V21l5.625-7.784z"/><path fill="#74A0F3" d="M12 21v-4.522l-5.625-3.262z"/><path fill="#CBA7F5" d="m12 15.43 5.625-3.263L12 9.652z"/><path fill="#74A0F3" d="M6.375 12.167 12 15.43V9.652z"/><path fill="#202699" fill-rule="evenodd" d="m12 15.43-5.625-3.263L12 3l5.624 9.166zm-5.252-3.528 5.161-8.41v6.114zm-.077.229 5.238-2.327v5.364zm5.418-2.327v5.364l5.234-3.037zm0-.198 5.161 2.296-5.161-8.41z" clip-rule="evenodd"/><path fill="#202699" fill-rule="evenodd" d="m12 16.406-5.625-3.195L12 21l5.624-7.79zm-4.995-2.633 4.904 2.79v4.005zm5.084 2.79v4.005l4.905-6.795z" clip-rule="evenodd"/></svg>',
  op: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="#FE0420" fill-rule="evenodd" d="M3.966 15.8q.979.7 2.512.7 1.854 0 2.962-.838 1.108-.85 1.559-2.562.27-1.05.464-2.163.063-.398.064-.663 0-.874-.451-1.499a2.7 2.7 0 0 0-1.237-.95Q9.053 7.5 8.062 7.5q-3.644 0-4.52 3.437a40 40 0 0 0-.477 2.163q-.058.335-.065.674 0 1.314.966 2.026m4.65-2.775c-.247.957-.926 1.58-1.958 1.58-1.02 0-1.368-.69-1.184-1.58a27 27 0 0 1 .464-2.05c.265-1.034.89-1.58 1.956-1.58 1.017 0 1.348.68 1.173 1.58a30 30 0 0 1-.451 2.05m3.902 3.385q.076.09.214.089h1.704a.38.38 0 0 0 .238-.089.36.36 0 0 0 .138-.232l.538-2.52h1.733c1.094 0 1.95-.53 2.576-1.002q.953-.707 1.266-2.186.075-.348.075-.67 0-1.117-.851-1.71-.84-.591-2.23-.591h-3.333a.38.38 0 0 0-.238.09.38.38 0 0 0-.138.232l-1.73 8.356a.3.3 0 0 0 .038.232m6.09-5.966c-.157.689-.757 1.319-1.462 1.319h-1.44l.496-2.369h1.503c.512 0 .94.102.94.665q0 .165-.037.385" clip-rule="evenodd"/></svg>',
  pol: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="url(#polygon__a)" d="m16.364 15.217 4.27-2.435a.73.73 0 0 0 .366-.627V7.284a.72.72 0 0 0-.366-.627l-4.27-2.435a.74.74 0 0 0-.732 0l-4.27 2.435a.72.72 0 0 0-.366.627v8.704l-2.994 1.707-2.994-1.707v-3.415l2.994-1.707 1.974 1.127V9.702l-1.608-.918a.75.75 0 0 0-.732 0l-4.27 2.435a.72.72 0 0 0-.366.627v4.87c0 .258.14.498.366.627l4.27 2.436a.75.75 0 0 0 .732 0l4.27-2.436a.72.72 0 0 0 .366-.626V8.012l.053-.03 2.94-1.677 2.994 1.707v3.415l-2.994 1.707-1.972-1.124v2.291l1.606.916a.75.75 0 0 0 .732 0z"/><defs><linearGradient id="polygon__a" x1="2.942" x2="20.119" y1="17.194" y2="7.101" gradientUnits="userSpaceOnUse"><stop stop-color="#A726C1"/><stop offset=".88" stop-color="#803BDF"/><stop offset="1" stop-color="#7B3FE4"/></linearGradient></defs></svg>',
  avax: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="#E84142" d="M7.515 19.874H4.492c-.637 0-.952 0-1.142-.118A.75.75 0 0 1 3 19.16c-.011-.224.146-.495.461-1.04l7.47-12.982c.32-.551.484-.827.687-.928a.76.76 0 0 1 .697 0c.202.101.36.377.675.928l1.542 2.643.005.012c.253.374.454.781.596 1.209.085.337.085.703 0 1.046a5 5 0 0 1-.596 1.22l-3.926 6.84-.011.023c-.201.408-.46.788-.766 1.125a2.36 2.36 0 0 1-.927.534c-.32.084-.675.084-1.39.084m7.645 0h4.33c.648 0 .968 0 1.16-.123a.75.75 0 0 0 .347-.596c.012-.22-.14-.478-.443-.991l-.034-.055-2.171-3.657-.023-.044c-.304-.507-.461-.765-.658-.866a.75.75 0 0 0-.692 0c-.202.1-.36.371-.675.91l-2.172 3.662v.012c-.32.538-.477.81-.466 1.029a.76.76 0 0 0 .348.601c.187.118.507.118 1.149.118"/></svg>',
  monad: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="#836EF9" d="M12 3c-2.599 0-9 6.4-9 9s6.401 9 9 9 9-6.401 9-9-6.401-9-9-9m-1.402 14.146c-1.097-.298-4.043-5.453-3.744-6.549s5.453-4.042 6.549-3.743c1.095.298 4.042 5.453 3.743 6.549-.298 1.095-5.453 4.042-6.549 3.743"/></svg>',
  sol: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="url(#solana__a)" d="M18.413 7.902a.62.62 0 0 1-.411.163H3.58c-.512 0-.77-.585-.416-.928l2.369-2.284a.6.6 0 0 1 .41-.169H20.42c.517 0 .77.59.41.935z"/><path fill="url(#solana__b)" d="M18.413 19.158a.62.62 0 0 1-.411.158H3.58c-.512 0-.77-.58-.416-.923l2.369-2.29a.6.6 0 0 1 .41-.163H20.42c.517 0 .77.586.41.928z"/><path fill="url(#solana__c)" d="M18.413 10.473a.62.62 0 0 0-.411-.158H3.58c-.512 0-.77.58-.416.923l2.369 2.29c.111.103.257.16.41.163H20.42c.517 0 .77-.586.41-.928z"/><defs><linearGradient id="solana__a" x1="3.001" x2="21.459" y1="55.041" y2="54.871" gradientUnits="userSpaceOnUse"><stop stop-color="#599DB0"/><stop offset="1" stop-color="#47F8C3"/></linearGradient><linearGradient id="solana__b" x1="3.001" x2="21.341" y1="9.168" y2="9.027" gradientUnits="userSpaceOnUse"><stop stop-color="#C44FE2"/><stop offset="1" stop-color="#73B0D0"/></linearGradient><linearGradient id="solana__c" x1="4.036" x2="20.303" y1="12.003" y2="12.003" gradientUnits="userSpaceOnUse"><stop stop-color="#778CBF"/><stop offset="1" stop-color="#5DCDC9"/></linearGradient></defs></svg>',
  sui: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="#4BA2FF" d="M16.128 10.508a5.44 5.44 0 0 1 1.15 3.356 5.47 5.47 0 0 1-1.182 3.4l-.063.079-.016-.107a5 5 0 0 0-.053-.26c-.37-1.656-1.566-3.08-3.546-4.233-1.334-.774-2.102-1.705-2.304-2.765a4.1 4.1 0 0 1 .16-1.969c.15-.494.385-.961.693-1.376l.773-.963a.332.332 0 0 1 .518 0zm1.218-.964L12.19 3.092a.244.244 0 0 0-.38 0L6.653 9.549l-.016.016a7.1 7.1 0 0 0-1.52 4.405C5.118 17.85 8.199 21 12 21s6.883-3.15 6.883-7.03a7.1 7.1 0 0 0-1.52-4.405zm-9.46.943.46-.577.017.105.037.255c.301 1.604 1.366 2.938 3.15 3.97 1.551.905 2.45 1.943 2.71 3.081.1.443.128.898.079 1.35v.027l-.021.01a5.2 5.2 0 0 1-2.319.544c-2.911 0-5.278-2.412-5.278-5.388a5.44 5.44 0 0 1 1.165-3.377"/></svg>',
  aptos: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="M15.336 9.02a.65.65 0 0 1-.483-.217l-.643-.726a.507.507 0 0 0-.757 0l-.552.623a.95.95 0 0 1-.713.322h-8.68a9 9 0 0 0-.473 2.221h8.196a.53.53 0 0 0 .38-.163l.764-.796a.5.5 0 0 1 .365-.155h.031c.145 0 .283.061.379.17l.643.726a.65.65 0 0 0 .483.218h6.69a9 9 0 0 0-.473-2.221zm-7.341 6.894a.53.53 0 0 0 .38-.163l.764-.796a.5.5 0 0 1 .365-.156h.031c.145 0 .283.062.379.17l.643.727a.65.65 0 0 0 .483.218h9.066c.34-.702.588-1.456.736-2.244h-8.701a.65.65 0 0 1-.483-.217l-.643-.727a.507.507 0 0 0-.757 0l-.552.624a.95.95 0 0 1-.713.321H3.158c.148.789.397 1.542.737 2.243zm6.431-9.32a.53.53 0 0 0 .382-.163l.763-.796a.5.5 0 0 1 .364-.155h.032c.144 0 .283.061.378.17l.643.727a.65.65 0 0 0 .484.217h1.723A8.99 8.99 0 0 0 12.001 3a8.99 8.99 0 0 0-7.195 3.594zm-5.82 11.544a.65.65 0 0 1-.484-.218l-.643-.726a.507.507 0 0 0-.756 0l-.552.623a.95.95 0 0 1-.713.321h-.037A8.97 8.97 0 0 0 12.001 21a8.97 8.97 0 0 0 6.578-2.862z"/></svg>',
};

/** EIP-55: all-lower or all-upper is accepted as is; mixed case must match the checksum (a typo guard). */
export function evmAddressError(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return 'Enter the full address: 0x followed by 40 letters and digits.';
  if (/^0x0{40}$/i.test(address)) return 'That is the zero address; nobody can use funds sent there.';
  const body = address.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return null;
  const h = hex(keccak_256(body.toLowerCase()));
  for (let i = 0; i < 40; i++) {
    const c = body[i];
    if (/[a-f]/i.test(c) && (c === c.toUpperCase()) !== parseInt(h[i], 16) >= 8) {
      return 'This address has a typo: its capital letters do not match its checksum.';
    }
  }
  return null;
}

const SOLANA_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const P25519 = 2n ** 255n - 19n;
const D25519 = 37095705934669439343138083508754565189542113879843219016388785533085940283555n;
const powP = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  for (b %= P25519; e > 0n; e >>= 1n, b = (b * b) % P25519) if (e & 1n) r = (r * b) % P25519;
  return r;
};
/**
 * Whether 32 bytes decompress to an ed25519 point, the way Solana decides it (curve25519-dalek: y taken mod p, x from
 * x² = (y²-1)/(d·y²+1) must exist). Off-curve addresses (token accounts, other PDAs) have no private key.
 */
export function ed25519OnCurve(key: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? key[i] & 0x7f : key[i]);
  const y2 = (y * y) % P25519;
  const x2 = (((y2 - 1n + P25519) % P25519) * powP((D25519 * y2 + 1n) % P25519, P25519 - 2n)) % P25519;
  return x2 === 0n || powP(x2, (P25519 - 1n) / 2n) === 1n;
}

const solanaKey = (address: string): Uint8Array | string => {
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return 'Enter the full Solana address: 32 to 44 letters and digits.';
  let bytes: Uint8Array;
  try {
    bytes = b58decode(address);
  } catch {
    return 'Enter the full Solana address: 32 to 44 letters and digits.';
  }
  if (bytes.length !== 32) return 'This is not a Solana address: check that you copied all of it.';
  if (bytes.every((b) => b === 0)) return 'That is the system program; nobody can use funds sent there.';
  return bytes;
};

/** Any Solana address (base58 of 32 bytes, not all zeros): what a 1Click deposit address must look like. */
export const solanaFormatError = (address: string): string | null => {
  const k = solanaKey(address);
  return typeof k === 'string' ? k : null;
};

/** A Solana wallet: a 32-byte public key on the ed25519 curve, not the USDC mint itself. */
export function solanaAddressError(address: string): string | null {
  const k = solanaKey(address);
  if (typeof k === 'string') return k;
  if (address === SOLANA_USDC_MINT) return 'That is the USDC token itself, not a wallet. Paste your own wallet address.';
  if (!ed25519OnCurve(k)) return 'This is not a wallet address (it may be a token account). Paste your wallet address.';
  return null;
}

/** Sui and Aptos: 0x and the full 64 hex digits (no short form), never all zeros. */
export function hex64AddressError(address: string): string | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(address)) return 'Enter the full address: 0x followed by 64 letters and digits.';
  if (/^0x0{64}$/i.test(address)) return 'That is the zero address; nobody can use funds sent there.';
  return null;
}

/**
 * A chain the recipient can be paid on. Every listed chain must be memo-free: we never send a
 * memo or tag. A chain that needs more checks before a quote (Stellar: account, trustline,
 * memo_required) adds them through `preflight` and its own `note`; the page stays the same.
 */
export interface PayoutChain {
  key: string;
  name: string;
  logo: string; // the chain's mark as inline SVG markup (24x24 viewBox, no size): our constant, safe for {@html}
  assetId: string; // pinned: never looked up by symbol (a lookalike 'USDC' could be listed first)
  decimals: number; // pinned, not taken from /v0/tokens
  placeholder: string;
  addressError(address: string): string | null; // a wallet the user holds: payout recipient, funding refund
  depositAddressError(address: string): string | null; // a 1Click deposit address on this chain
  preflight?(address: string, fetchFn?: Fetch): Promise<string | null>;
  note: string;
}

const chain = (
  key: string,
  name: string,
  assetId: string,
  placeholder: string,
  addressError: (a: string) => string | null,
  depositAddressError = addressError,
): PayoutChain => ({
  key,
  name,
  logo: LOGOS[key],
  assetId,
  decimals: 6,
  placeholder,
  addressError,
  depositAddressError,
  note: `Paste your own ${name} wallet address. If it is an exchange address, make sure the exchange credits USDC on ${name} to it without a memo or tag.`,
});
const evmChain = (key: string, name: string, assetId: string) => chain(key, name, assetId, '0x…', evmAddressError);

/**
 * Base first (the owner's pick); each is hidden at runtime if 1Click stops listing it. Only Circle's native USDC,
 * checked on 14 Nov 2026 against developers.circle.com/stablecoins/usdc-contract-addresses (the token address 1Click
 * lists for each id below is Circle's). Left out: BNB and Gnosis (not Circle's), X Layer (1Click routes USDC.e),
 * Stellar (funding needs a memo, payout a trustline). The verifier pins the same ids (verifier/src/intents.ts).
 */
export const PAYOUT_CHAINS: PayoutChain[] = [
  evmChain('base', 'Base', 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near'),
  evmChain('arb', 'Arbitrum', 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near'),
  evmChain('eth', 'Ethereum', 'nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near'),
  evmChain('op', 'Optimism', 'nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ'), // 0x0b2c…ff85
  evmChain('pol', 'Polygon', 'nep141:pol-0x3c499c542cef5e3811e1192ce70d8cc03d5c3359.omdep.near'),
  evmChain('avax', 'Avalanche', 'nep141:avax-0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e.omdep.near'),
  evmChain('monad', 'Monad', 'nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx'), // 0x7547…b603
  chain('sol', 'Solana', 'nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near', 'Your Solana wallet address', solanaAddressError, solanaFormatError), // EPjF…Dt1v
  chain('sui', 'Sui', 'nep141:sui-c1b81ecaf27933252d31a963bc5e9458f13c18ce.omft.near', '0x… (64 digits)', hex64AddressError), // 0xdba3…::usdc::USDC
  chain('aptos', 'Aptos', 'nep141:aptos-34ee497f210c5a511e8d5b53bc56d75b63612bb5.omft.near', '0x… (64 digits)', hex64AddressError), // 0xbae2…6f3b
];

/** The USDC and NEAR marks, same source and treatment as LOGOS (@web3icons/core 4.0.59, MIT). Render with markLogo(). */
export const MARKS = {
  usdc: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="#0B53BF" d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18"/><path fill="#fff" d="M13.62 5.45v1.159a5.64 5.64 0 0 1 4.005 5.394 5.64 5.64 0 0 1-4.005 5.394v1.16a6.74 6.74 0 0 0 5.13-6.554 6.74 6.74 0 0 0-5.13-6.553m-7.245 6.553a5.64 5.64 0 0 1 4.005-5.394V5.45a6.74 6.74 0 0 0-5.13 6.553 6.74 6.74 0 0 0 5.13 6.553v-1.159a5.63 5.63 0 0 1-4.005-5.394"/><path fill="#fff" d="M14.419 13.258c0-2.301-3.606-1.356-3.606-2.627 0-.456.366-.748 1.063-.748.833 0 1.12.405 1.21.95h1.147c-.102-1.024-.69-1.67-1.67-1.863v-.904h-1.125v.872c-1.075.137-1.75.762-1.75 1.693 0 2.312 3.611 1.445 3.611 2.694 0 .472-.455.787-1.226.787-1.007 0-1.339-.444-1.462-1.057H9.49c.073 1.122.764 1.823 1.947 1.999v.886h1.125v-.875c1.153-.149 1.856-.82 1.856-1.807"/></svg>',
  near: '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><path fill="currentColor" d="m17.425 3.92-3.76 5.58c-.257.385.244.835.604.52l3.28-3.214c.095-.083.236-.026.236.115v10.062c0 .135-.18.192-.256.096L6.754 3.681a1.85 1.85 0 0 0-1.459-.68C4.138 3 3 3.584 3 4.922V19.07a1.922 1.922 0 0 0 3.555 1.003l3.754-5.58c.257-.385-.238-.835-.598-.52l-3.26 3.279c-.096.083-.237.026-.237-.117V7.101c0-.14.18-.192.257-.096L17.226 20.32c.36.444.9.681 1.46.681C19.848 21 21 20.421 21 19.078V4.93a1.93 1.93 0 0 0-3.575-1.003z"/></svg>',
} as const;

let logoInstances = 0;
/** SVG markup with its gradient ids (and url(#…) references) unique for this instance; see chainLogo(). */
export function markLogo(svg: string): string {
  const n = ++logoInstances;
  return svg.replace(/(id="|url\(#)([\w-]+__\w+)/g, `$1$2-${n}`);
}

/**
 * `c.logo` with its gradient ids (and their url(#…) references) made unique for this instance. Render logos with
 * {@html chainLogo(c)}: the same chain shown twice (selected value and its option) would otherwise repeat an id, and a
 * gradient whose first copy sits in a hidden element does not paint.
 */
export function chainLogo(c: PayoutChain): string {
  return markLogo(c.logo);
}
