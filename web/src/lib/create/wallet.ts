// Sender wallet through NEAR Connect (@hot-labs/near-connect), NEAR's replacement for the deprecated wallet
// selector: it shows a wallet picker and runs each wallet's code in a sandboxed iframe. MyNearWallet stopped
// accepting app connections in Nov 2026, so it is excluded. Loaded only by /create, /campaigns and the claim form.

import type { Tx } from './funding';
// Pinned copy of NEAR Connect's manifest (hot-dao/near-selector repository/manifest.json, v1.1.0, 12 Nov 2026),
// cut to the wallets we offer: no runtime manifest fetch, and no wallet appears that we have not looked at.
// ethereum-wallets (MetaMask on NEAR, NEP-518) is copied verbatim; its executor is served unpinned by evm-on-near.dev.
import manifest from './wallets.json';


export interface SenderWallet {
  accountId(): string | null;
  signIn(): Promise<string>;
  signOut(): Promise<void>;
  /** Signs and sends in order; returns the tx hashes. */
  send(txs: Tx[]): Promise<string[]>;
}

/** What the wallet is handed: exactly fundingTxs' transactions, the signer named once (NEAR Connect's shape). */
export const walletRequest = (txs: Tx[]) => ({
  signerId: txs[0]?.signerId,
  transactions: txs.map((t) => {
    if (t.signerId !== txs[0].signerId) throw new Error('one signer per request');
    return { receiverId: t.receiverId, actions: t.actions };
  }),
});

export async function nearConnectWallet(networkId: string, rpcUrl: string): Promise<SenderWallet> {
  const { NearConnector } = await import('@hot-labs/near-connect');
  const network = networkId === 'mainnet' ? 'mainnet' : 'testnet';
  const connector = new NearConnector({
    network,
    providers: { [network]: [rpcUrl] },
    features: { signAndSendTransactions: true },
    manifest: manifest as never,
    excludedWallets: ['mynearwallet'], // retired: it refuses new app connections
    autoConnect: true,
    // The wallet code runs in srcdoc iframes, which inherit this page's CSP: its inline scripts need our nonce.
    cspNonce: (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce || undefined,
  });
  let account: string | null = null;
  try {
    account = (await connector.getConnectedWallet()).accounts[0]?.accountId ?? null;
  } catch {
    // not connected yet
  }
  return {
    accountId: () => account,
    async signIn() {
      const wallet = await connector.connect();
      const [a] = await wallet.getAccounts();
      if (!a) throw new Error('NO_ACCOUNT');
      return (account = a.accountId);
    },
    async signOut() {
      await connector.disconnect();
      account = null;
    },
    async send(txs) {
      const wallet = await connector.wallet();
      const outcomes = await wallet.signAndSendTransactions(walletRequest(txs));
      return (outcomes ?? []).map((o) => o.transaction.hash);
    },
  };
}
