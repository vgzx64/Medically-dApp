/**
 * Wallet abstraction.
 *
 * Two modes are supported:
 *   injected - MetaMask / any browser wallet exposing `window.ethereum`
 *   dev      - a built-in ethers v6 Wallet bound to an Anvil test key, used
 *               for reproducible CI runs and for automated screenshots
 *
 * Both modes implement the same minimal interface, so the UI code never
 * needs to know which one is active.
 */

import { BrowserProvider, JsonRpcProvider, Signer, Wallet, type Eip1193Provider } from 'ethers';
import { config } from './config';

export type WalletMode = 'injected' | 'dev';

export interface ConnectedWallet {
  mode: WalletMode;
  address: string;
  chainId: number;
  signer: Signer;
  provider: BrowserProvider | JsonRpcProvider;
  label: string;
}

export interface Eip1193Error {
  code?: number;
  message?: string;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider & {
      isMetaMask?: boolean;
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
      on?(event: string, handler: (...args: unknown[]) => void): void;
      removeListener?(event: string, handler: (...args: unknown[]) => void): void;
    };
  }
}

/** Errors reported by injected wallets when the user rejects a signature. */
export const USER_REJECTED_CODES = [4001, -32603];

export const isUserRejection = (error: unknown): boolean => {
  const err = error as Eip1193Error | undefined;
  if (!err) return false;
  if (err.code !== undefined && USER_REJECTED_CODES.includes(err.code)) {
    // MetaMask uses 4001; some providers report -32603 for a user rejection.
    return err.code === 4001 || /user rejected|denied|rejected/i.test(err.message ?? '');
  }
  return /user rejected|denied|rejected|denied by user/i.test(err.message ?? '');
};

export const hasInjectedWallet = (): boolean =>
  typeof window !== 'undefined' && Boolean(window.ethereum);

export const readInjectedChainId = async (): Promise<number> => {
  if (!hasInjectedWallet()) throw new Error('No injected wallet found');
  const raw = await window.ethereum!.request({ method: 'eth_chainId' });
  return Number.parseInt(String(raw), 16);
};

/** Ask the injected wallet to switch to the expected chain. */
export const switchToChain = async (chainId: number, networkName: string): Promise<void> => {
  if (!hasInjectedWallet()) throw new Error('No injected wallet found');
  const current = await readInjectedChainId();
  if (current === chainId) return;

  const hexChainId = `0x${chainId.toString(16)}`;
  try {
    await window.ethereum!.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: hexChainId }],
    });
  } catch (error) {
    // 4902 = chain unknown to the wallet, it has to be added first.
    const code = (error as Eip1193Error).code;
    if (code === 4902 || code === -32603) {
      await window.ethereum!.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hexChainId,
            chainName: networkName,
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [config.rpcUrl],
          },
        ],
      });
      return;
    }
    throw error;
  }
}

/** Connect using MetaMask (or any injected provider). */
export const connectInjected = async (): Promise<ConnectedWallet> => {
  if (!hasInjectedWallet()) {
    throw new Error('No injected wallet found - install MetaMask or use the dev wallet mode');
  }

  const browserProvider = new BrowserProvider(window.ethereum!);
  const accounts = await browserProvider.send('eth_requestAccounts', []);
  if (!accounts || accounts.length === 0) {
    throw new Error('The wallet returned no accounts');
  }

  const network = await browserProvider.getNetwork();
  const signer = await browserProvider.getSigner();

  return {
    mode: 'injected',
    address: await signer.getAddress(),
    chainId: Number(network.chainId),
    signer,
    provider: browserProvider,
    label: window.ethereum!.isMetaMask ? 'MetaMask' : 'Injected wallet',
  };
};

/** Connect the built-in dev wallet (Anvil test key). */
export const connectDev = async (): Promise<ConnectedWallet> => {
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId);
  const wallet = new Wallet(config.devPrivateKey, provider);

  const network = await provider.getNetwork();
  if (Number(network.chainId) !== config.chainId) {
    throw new Error(
      `RPC chain id ${network.chainId} does not match the expected ${config.chainId}`,
    );
  }

  return {
    mode: 'dev',
    address: await wallet.getAddress(),
    chainId: Number(network.chainId),
    signer: wallet,
    provider,
    label: 'Dev wallet (Anvil)',
  };
};

/** Connect using the mode configured for this deployment. */
export const connect = async (mode?: WalletMode): Promise<ConnectedWallet> => {
  const effective = mode ?? config.walletMode;
  return effective === 'dev' ? connectDev() : connectInjected();
};

/** Subscribe to the account/chain changes of an injected wallet. */
export const onInjectedChanges = (
  handler: (accounts: string[], chainId: number) => void,
): (() => void) => {
  if (!hasInjectedWallet() || !window.ethereum!.on) return () => undefined;

  const accountsChanged = (...args: unknown[]) => {
    handler((args[0] as string[]) ?? [], 0);
  };
  const chainChanged = (...args: unknown[]) => {
    const chainId = Number.parseInt(String(args[0]), 16);
    handler([], chainId);
  };

  window.ethereum!.on!('accountsChanged', accountsChanged);
  window.ethereum!.on!('chainChanged', chainChanged);

  return () => {
    window.ethereum!.removeListener?.('accountsChanged', accountsChanged);
    window.ethereum!.removeListener?.('chainChanged', chainChanged);
  };
};
