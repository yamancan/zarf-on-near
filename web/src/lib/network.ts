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
