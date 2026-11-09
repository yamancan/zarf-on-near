// Sender wallet: MyNearWallet through @near-wallet-selector (popup + postMessage, no page redirect).
// Loaded only by /create, so the claim page never ships wallet code.

import type { Tx } from './funding';

export interface SenderWallet {
  accountId(): string | null;
  signIn(): Promise<string>;
  signOut(): Promise<void>;
  /** Signs and sends in order; returns the tx hashes. */
  send(txs: Tx[]): Promise<string[]>;
}

export async function myNearWallet(networkId: string, rpcUrl: string): Promise<SenderWallet> {
  // MyNearWallet builds its popup URL with Node's Buffer; browsers have none. Only /create loads this.
  (globalThis as { Buffer?: unknown }).Buffer ??= (await import('buffer')).Buffer;
  const [{ setupWalletSelector }, { setupMyNearWallet }, { actionCreators }] = await Promise.all([
    import('@near-wallet-selector/core'),
    import('@near-wallet-selector/my-near-wallet'),
    import('@near-js/transactions'),
  ]);
  const selector = await setupWalletSelector({
    network: { networkId, nodeUrl: rpcUrl, helperUrl: '', explorerUrl: '', indexerUrl: '' },
    modules: [setupMyNearWallet()],
  });
  const wallet = await selector.wallet('my-near-wallet');
  return {
    accountId: () => selector.store.getState().accounts[0]?.accountId ?? null,
    async signIn() {
      const [account] = await wallet.signIn({ accounts: [] });
      return account.accountId;
    },
    signOut: () => wallet.signOut(),
    async send(txs) {
      // wallet-selector v10 takes @near-js actions; our Tx stays a plain, testable shape until here.
      const transactions = txs.map((t) => ({
        signerId: t.signerId,
        receiverId: t.receiverId,
        actions: t.actions.map(({ params: p }) => actionCreators.functionCall(p.methodName, p.args, BigInt(p.gas), BigInt(p.deposit))),
      }));
      const outcomes = await wallet.signAndSendTransactions({ transactions });
      return (outcomes ?? []).map((o) => o.transaction.hash);
    },
  };
}
