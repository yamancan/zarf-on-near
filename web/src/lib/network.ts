import { env } from '$env/dynamic/public';

// One source for the network cue: the contract id names it (zarf-near-1112.testnet). Mainnet needs no label.
export const TESTNET = env.PUBLIC_CONTRACT_ID?.endsWith('.testnet') ?? false;
/** The unit beside every amount: "test USDC" on testnet (rendered uppercase by Amount), "USDC" on mainnet. */
export const UNIT = TESTNET ? 'test USDC' : 'USDC';
