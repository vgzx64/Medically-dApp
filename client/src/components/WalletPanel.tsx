import { useEffect, useState } from 'react';
import { config, chainName } from '../lib/config';
import { hasInjectedWallet } from '../lib/wallet';
import { readOnlyContract } from '../lib/consent';
import type { UseRegistry } from '../hooks/useRegistry';

/** Wallet connection panel: mode selection, network guard, account info. */
export const WalletPanel = ({ app }: { app: UseRegistry }) => {
  const { wallet, connecting, connectError, networkOk, networkMessage, connect, disconnect } = app;

  const [paused, setPaused] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (!wallet) {
      setPaused(undefined);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const contract = readOnlyContract(wallet.provider as any);
        const p = await contract.paused();
        if (!cancelled) setPaused(p as boolean);
      } catch {
        if (!cancelled) setPaused(undefined);
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  return (
    <div className="card">
      <div className="card-header fw-bold">Wallet &amp; network</div>
      <div className="card-body">

        {!wallet && (
          <div className="row mb-3">
            <div className="col-auto">
              <button
                className="btn btn-primary"
                onClick={() => void connect('injected')}
                disabled={connecting || !hasInjectedWallet()}
              >
                {connecting ? 'Connecting…' : 'Connect MetaMask '}
                <span className="small text-muted">(chainId {config.chainId})</span>
              </button>
            </div>
            <div className="col-auto">
              <button
                className="btn btn-outline-secondary"
                onClick={() => void connect('dev')}
                disabled={connecting}
              >
                Use dev wallet (Anvil) <span className="small text-muted">(chainId 31337)</span>
              </button>
            </div>
          </div>
        )}

        {!hasInjectedWallet() && (
          <p className="text-muted small mb-3">
            No injected wallet detected in this browser. Use the dev wallet mode (Anvil test key)
            or install MetaMask.
          </p>
        )}

        {connectError && <div className="alert alert-danger">{`Connection failed: ${connectError}`}</div>}

        {wallet && (
          <>
            <dl className="row mb-3">
              <dt className="col-4 text-muted text-nowrap">Account</dt>
              <dd className="col-8 text-break"><code className="small">{wallet.address}</code></dd>
              <dt className="col-4 text-muted text-nowrap">Wallet</dt>
              <dd className="col-8">{wallet.label}</dd>
              <dt className="col-4 text-muted text-nowrap">Chain</dt>
              <dd className="col-8">
                <span className={`badge ${networkOk ? 'bg-success' : 'bg-danger text-white'}`}>
                  {networkOk ? 'OK' : 'WRONG NETWORK'}
                </span>{' '}
                {networkMessage}
              </dd>
              <dt className="col-4 text-muted text-nowrap">Expected</dt>
              <dd className="col-8">
                {chainName(config.chainId)} ({config.chainId})
              </dd>
              <dt className="col-4 text-muted text-nowrap">Contract</dt>
              <dd className="col-8 text-break"><code className="small">{config.contractAddress}</code></dd>
              <dt className="col-4 text-muted text-nowrap">Paused</dt>
              <dd className="col-8">
                <span className={`badge ${paused ? 'bg-danger' : 'bg-success'}`}>
                  {paused ? 'YES' : 'NO'}
                </span>
              </dd>
            </dl>
            <div className="row">
              <div className="col-auto">
                <button className="btn btn-outline-secondary" onClick={disconnect}>
                  Disconnect
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
