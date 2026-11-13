// Sender wallet through NEAR Connect (@hot-labs/near-connect), NEAR's replacement for the deprecated wallet
// selector: it shows a wallet picker and runs each wallet's code in a sandboxed iframe. MyNearWallet stopped
// accepting app connections in Nov 2026, so it is excluded. Loaded only by /create, /campaigns and the claim form.

import { AccountChanged, type Tx } from './funding';
// Pinned copy of NEAR Connect's manifest (hot-dao/near-selector repository/manifest.json, v1.1.0, 12 Nov 2026),
// cut to the wallets we offer: no runtime manifest fetch, and no wallet appears that we have not looked at.
import manifest from './wallets.json';
// MetaMask on NEAR (NEP-518, "Ethereum Wallets"), the upstream entry plus an `integrity` pin of its executor
// (sha256 of evm-on-near.dev/executor.js, 14 Nov 2026; a changed file fails to load). Signing happens in a popup on
// evm-on-near.dev, which is not pinned. Senders get it on /create and /campaigns (T-025); the claim form only with 0x ids on.
import ethereumWallets from './ethereum-wallets.json';


export interface SenderWallet {
  accountId(): string | null;
  /** The connected wallet's manifest id ('ethereum-wallets' for MetaMask), or null. */
  walletId(): string | null;
  /** Called on every sign-in and sign-out the connector reports, from any path (picker, wallet, disconnect). */
  onChange(cb: (account: string | null, walletId: string | null) => void): void;
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

/**
 * NEAR Connect re-reads the selected wallet on every call, so another tab can switch it under this one
 * (T-012 finding 2). Refuse before signing unless the wallet about to sign holds the request's signer.
 */
export function assertSigner(accounts: readonly { accountId: string }[], txs: Tx[]): void {
  const signer = txs[0]?.signerId;
  if (!signer || !accounts.some((a) => a.accountId === signer)) throw new AccountChanged(signer ?? '');
}

export async function nearConnectWallet(networkId: string, rpcUrl: string, { ethereum = false } = {}): Promise<SenderWallet> {
  const { NearConnector } = await import('@hot-labs/near-connect');
  const network = networkId === 'mainnet' ? 'mainnet' : 'testnet';
  const connector = new NearConnector({
    network,
    providers: { [network]: [rpcUrl] },
    features: { signAndSendTransactions: true },
    manifest: (ethereum ? { ...manifest, wallets: [...manifest.wallets, ethereumWallets] } : manifest) as never,
    excludedWallets: ['mynearwallet'], // retired: it refuses new app connections
    autoConnect: true,
    // The wallet code runs in srcdoc iframes, which inherit this page's CSP: its inline scripts need our nonce.
    cspNonce: (document.querySelector('script[nonce]') as HTMLScriptElement | null)?.nonce || undefined,
  });
  // T-032 wallet finding: this restores the session NEAR Connect stored, read from the wallet's sandboxed code, not a
  // live check. For Ethereum Wallets that is the 0x account from an earlier visit while MetaMask itself is asked only
  // in the signing popup. So the page names the wallet and follows the connector's own sign-in/out events.
  let account: string | null = null;
  let walletId: string | null = null;
  let changed: (account: string | null, walletId: string | null) => void = () => {};
  try {
    const c = await connector.getConnectedWallet();
    account = c.accounts[0]?.accountId ?? null;
    walletId = account ? c.wallet.manifest.id : null;
  } catch {
    // not connected yet
  }
  connector.on('wallet:signIn', (e: { wallet: { manifest: { id: string } }; accounts: { accountId: string }[] }) => {
    account = e.accounts[0]?.accountId ?? null;
    walletId = account ? e.wallet.manifest.id : null;
    changed(account, walletId);
  });
  connector.on('wallet:signOut', () => {
    account = walletId = null;
    changed(null, null);
  });
  return {
    accountId: () => account,
    walletId: () => walletId,
    onChange: (cb) => void (changed = cb),
    async signIn() {
      const wallet = await connector.connect();
      const [a] = await wallet.getAccounts();
      if (!a) throw new Error('NO_ACCOUNT');
      walletId = wallet.manifest.id;
      return (account = a.accountId);
    },
    async signOut() {
      await connector.disconnect();
      account = walletId = null;
    },
    async send(txs) {
      const wallet = await connector.wallet();
      assertSigner(await wallet.getAccounts(), txs);
      const outcomes = await wallet.signAndSendTransactions(walletRequest(txs));
      return (outcomes ?? []).map((o) => o.transaction.hash);
    },
  };
}
