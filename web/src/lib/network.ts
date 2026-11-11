import { env } from '$env/dynamic/public';

// One source for the network cue: the contract id names it (zarf-near-1112.testnet). Mainnet needs no label.
export const TESTNET = env.PUBLIC_CONTRACT_ID?.endsWith('.testnet') ?? false;
/** The unit beside every amount: "test USDC" on testnet (rendered uppercase by Amount), "USDC" on mainnet. */
export const UNIT = TESTNET ? 'test USDC' : 'USDC';
/** The USDC sentence (owner ruling, 12 Nov): shown once per entry point, where the term first appears. */
export const USDC_LINES = [
  'USDC is a digital dollar issued by Circle, built to stay worth 1 US dollar.',
  ...(TESTNET ? ['Test USDC is its free practice version on NEAR testnet: it has no value.'] : []),
];
/** An account's page on the same explorer as the tx links (nearblocks: /txns/<hash> → /address/<account>); '' if none. */
export const accountExplorerUrl = (txUrl: string | undefined, account: string): string =>
  txUrl && /\/txns\/$/.test(txUrl) ? `${txUrl.replace(/\/txns\/$/, '/address/')}${encodeURIComponent(account)}` : '';

/** Mainnet landing and claim card (owner, 12 Nov): one line, one layer down. */
export const UNAUDITED_LINE = 'Zarf on NEAR is new and has not been audited yet. Our app caps each send at 100 USDC for now.';

/** Mainnet create (second audit S3): Circle controls USDC, and nothing in Zarf can override it. */
export const CIRCLE_LINE = 'Circle can pause USDC or block an account; that would stop claims and take-backs until Circle lifts it. Zarf cannot override it.';
