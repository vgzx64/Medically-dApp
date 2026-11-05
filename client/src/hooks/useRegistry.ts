/**
 * React hook that owns the whole dApp state: wallet, contract, events,
 * transaction lifecycle, telemetry and the detection engine.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Contract, type Provider } from 'ethers';
import { config, chainName } from '../lib/config';
import { REGISTRY_ABI } from '../lib/abi';
import {
  backfillEvents,
  decodeConsentEvent,
  mergeEvents,
  type ConsentEvent,
} from '../lib/events';
import {
  connect as connectWallet,
  hasInjectedWallet,
  isUserRejection,
  onInjectedChanges,
  readInjectedChainId,
  switchToChain,
  type ConnectedWallet,
  type WalletMode,
} from '../lib/wallet';
import { initialTxState, runTransaction, stageLabel, type TxState, type TxStage } from '../lib/tx';
import { Telemetry, consoleSink, MemorySink, newCorrelationId, type TelemetryRecord } from '../lib/telemetry';
import { DetectionEngine, type Alert } from '../lib/rules';
import { REGISTRY_INTERFACE } from '../lib/consent';
import { hasContractCode } from '../lib/contract';

const TX_STAGE_ORDER: TxStage[] = [
  'idle',
  'awaiting_signature',
  'signing',
  'sent',
  'pending',
  'confirmed',
];

export interface RegistryState {
  wallet: ConnectedWallet | undefined;
  connected: boolean;
  connecting: boolean;
  connectError: string | undefined;
  networkOk: boolean;
  networkMessage: string;
  events: ConsentEvent[];
  tx: TxState;
  alerts: Alert[];
  telemetry: TelemetryRecord[];
  deploymentBlock: number;
  contractReady: boolean;
  /** Human readable reason why the contract cannot be used (undefined = fine). */
  contractProblem: string | undefined;
}

export interface UseRegistry extends RegistryState {
  connect: (mode?: WalletMode) => Promise<void>;
  disconnect: () => void;
  refreshEvents: () => Promise<void>;
  send: (
    action: () => Promise<Contract['runner'] extends never ? never : any>,
    method: string,
  ) => Promise<string | undefined>;
  engine: DetectionEngine;
}

export const useRegistry = (): UseRegistry => {
  const [wallet, setWallet] = useState<ConnectedWallet | undefined>();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | undefined>();
  const [events, setEvents] = useState<ConsentEvent[]>([]);
  const [tx, setTx] = useState<TxState>(initialTxState);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryRecord[]>([]);
  const [deploymentBlock, setDeploymentBlock] = useState(0);
  const [contractReady, setContractReady] = useState(false);
  const [contractProblem, setContractProblem] = useState<string | undefined>();

  const memorySink = useRef(new MemorySink(500));
  const engine = useRef(new DetectionEngine());
  const telemetryRef = useRef<Telemetry>();

  if (!telemetryRef.current) {
    telemetryRef.current = new Telemetry((record) => {
      memorySink.current.sink(record);
      consoleSink(record);
      setTelemetry([...memorySink.current.records]);
      const alert = engine.current.ingest(record);
      if (alert) setAlerts(engine.current.getAlerts());
    }, { chainId: config.chainId, contractAddress: config.contractAddress });
  }

  const tel = telemetryRef.current;

  // Computed directly (not memoized) so it always uses the latest
  // config.chainId from the mutable module-level config object.
  const networkOk = wallet ? wallet.chainId === config.chainId : false;
  const networkMessage = wallet
    ? wallet.chainId === config.chainId
      ? `${chainName(wallet.chainId)} (${wallet.chainId})`
      : `Wrong network: expected ${chainName(config.chainId)} (${config.chainId}), got ${chainName(wallet.chainId)} (${wallet.chainId})`
    : 'Wallet is not connected';

  // Verify that the configured address actually holds code: a stale
  // localStorage override or a restarted Anvil would otherwise leave every
  // panel silently empty.
  const verifyContract = useCallback(
    async (w: ConnectedWallet): Promise<boolean> => {
      const address = config.contractAddress;
      if (!address) {
        setContractReady(false);
        setContractProblem(
          'No contract address configured: deploy the registry (./tools/localnet.sh deploy) or set VITE_CONTRACT_ADDRESS.',
        );
        return false;
      }

      const network = `${chainName(w.chainId)} (${w.chainId})`;
      if (!(await hasContractCode(w.provider as Provider, address))) {
        setContractReady(false);
        setContractProblem(
          `No contract at ${address} on ${network}. Deploy it (./tools/localnet.sh deploy, then restart npm run dev) or reset the configuration.`,
        );
        tel.rpc('contract.missing', {
          level: 'error',
          contractAddress: address,
          context: { chainId: w.chainId },
        });
        return false;
      }

      setContractReady(true);
      setContractProblem(undefined);
      return true;
    },
    [tel],
  );

  const loadEvents = useCallback(
    async (w: ConnectedWallet, fromBlock: number) => {
      const address = config.contractAddress;
      if (!address) return;
      try {
        const provider = w.provider as Provider;
        const contract = new Contract(address, REGISTRY_ABI, provider);
        const block = await provider.getBlockNumber();
        const from = fromBlock > 0 ? fromBlock : Math.max(0, block - 200);
        const loaded = await backfillEvents(contract, REGISTRY_INTERFACE, provider, from);
        setEvents((prev) => mergeEvents(prev, loaded));
        setDeploymentBlock(from);
        tel.contract('events.backfilled', {
          metrics: { count: loaded.length, fromBlock: from, toBlock: block },
        });
      } catch (error) {
        tel.rpc('events.backfill_failed', {
          level: 'warn',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [tel],
  );

  const subscribe = useCallback(
    (w: ConnectedWallet) => {
      const address = config.contractAddress;
      if (!address) return () => {};
      const provider = w.provider as Provider;
      const contract = new Contract(address, REGISTRY_ABI, provider);

      const handle = async (log: any) => {
        const block = await provider.getBlock(log.blockNumber);
        const event = decodeConsentEvent(
          REGISTRY_INTERFACE,
          log,
          Number(block?.timestamp ?? 0),
        );
        if (!event) return;
        setEvents((prev) => mergeEvents(prev, [event]));
        if (event.kind === 'recorded' || event.kind === 'revoked') {
          tel.contract(`event.${event.kind}`, {
            txHash: event.txHash,
            context: {
              consentId: event.consentId,
              patient: event.patient,
              issuer: event.kind === 'recorded' ? event.issuer : event.revokedBy,
            },
          });
        }
      };

      contract.on('ConsentRecorded', handle);
      contract.on('ConsentRevoked', handle);
      contract.on('RegistrarUpdated', handle);
      contract.on('ContractPaused', handle);
      contract.on('ContractUnpaused', handle);

      return () => {
        contract.off('ConsentRecorded', handle);
        contract.off('ConsentRevoked', handle);
        contract.off('RegistrarUpdated', handle);
        contract.off('ContractPaused', handle);
        contract.off('ContractUnpaused', handle);
      };
    },
    [tel],
  );

  const connect = useCallback(
    async (mode?: WalletMode) => {
      if (connecting) return;
      setConnecting(true);
      setConnectError(undefined);
      const correlationId = newCorrelationId();
      try {
        if (mode === 'injected') {
          if (!hasInjectedWallet()) {
            throw new Error('No injected wallet found - install MetaMask or use the dev wallet mode');
          }
          // Step 1: ask for accounts
          const accounts = await window.ethereum!.request({
            method: 'eth_requestAccounts',
            params: [],
          });
          if (!accounts || accounts.length === 0) {
            throw new Error('The wallet returned no accounts');
          }
          // Step 2: switch to the expected chain (31337 = Anvil local).
          // If the chain is unknown to MetaMask, wallet_addEthereumChain is
          // invoked, and MetaMask prompts the user to add the network.
          await switchToChain(config.chainId, chainName(config.chainId));
          // Step 3: now we are on the right chain - create provider and sign
          const w = await connectWallet('injected');
          setWallet(w);
          tel.app('wallet.connected', {
            correlationId,
            from: w.address.toLowerCase(),
            context: { mode: 'injected', label: w.label, chainId: w.chainId },
          });
          if (await verifyContract(w)) await loadEvents(w, 0);
        } else {
          const w = await connectWallet(mode);
          setWallet(w);
          tel.app('wallet.connected', {
            correlationId,
            from: w.address,
            context: { mode: w.mode, label: w.label, chainId: w.chainId },
          });
          if (await verifyContract(w)) await loadEvents(w, 0);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setConnectError(message);
        tel.app('wallet.connect_failed', {
          correlationId,
          level: 'error',
          message,
          context: { userRejected: isUserRejection(error) },
        });
      } finally {
        setConnecting(false);
      }
    },
    [loadEvents, tel, verifyContract, connecting],
  );

  const disconnect = useCallback(() => {
    setWallet(undefined);
    setContractReady(false);
    setContractProblem(undefined);
    setEvents([]);
    tel.app('wallet.disconnected');
  }, [tel]);

  const refreshEvents = useCallback(async () => {
    if (!wallet) return;
    await loadEvents(wallet, deploymentBlock);
  }, [wallet, deploymentBlock, loadEvents]);

  // live subscription
  useEffect(() => {
    if (!wallet) return undefined;
    const unsubscribe = subscribe(wallet);
    return unsubscribe;
  }, [wallet, subscribe]);

  // injected wallet notifications
  useEffect(() => {
    if (wallet?.mode !== 'injected') return undefined;
    return onInjectedChanges(() => {
      void connect('injected');
    });
  }, [wallet?.mode, connect]);

  // poll the chain id of the injected wallet (never a dev wallet)
  useEffect(() => {
    if (wallet?.mode !== 'injected' || !hasInjectedWallet()) return undefined;
    const timer = setInterval(async () => {
      try {
        const chainId = await readInjectedChainId();
        setWallet((prev) => (prev && prev.chainId !== chainId ? { ...prev, chainId } : prev));
      } catch {
        // the wallet may be locked - the next poll will recover
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [wallet?.mode]);

  const send = useCallback(
    async (action: () => Promise<any>, method: string): Promise<string | undefined> => {
      if (!wallet) {
        setTx({ stage: 'failed', error: 'Wallet is not connected', errorName: 'NO_WALLET' });
        return undefined;
      }

      // The registry must be reachable before anything is signed.
      if (!contractReady) {
        const message = contractProblem ?? 'The registry contract is not available';
        setTx({ stage: 'failed', error: message, errorName: 'CONTRACT_MISSING' });
        tel.tx('tx.failed', {
          level: 'error',
          from: wallet.address,
          method,
          message,
          context: { reason: 'CONTRACT_MISSING' },
        });
        return undefined;
      }

      // The contract is deployed on one chain only: refuse to sign for another.
      if (wallet.chainId !== config.chainId) {
        setTx({ stage: 'failed', error: networkMessage, errorName: 'WRONG_NETWORK' });
        tel.tx('tx.failed', {
          level: 'error',
          from: wallet.address,
          method,
          message: networkMessage,
          context: { reason: 'WRONG_NETWORK', expectedChainId: config.chainId, actualChainId: wallet.chainId },
        });
        return undefined;
      }

      const correlationId = newCorrelationId();
      const started = Date.now();

      setTx({ stage: 'awaiting_signature' });
      tel.tx('tx.started', { correlationId, from: wallet.address, method });

      try {
        const receipt = await runTransaction(action, {
          iface: REGISTRY_INTERFACE,
          onState: (state) => {
            setTx(state);
            tel.tx(`tx.${state.stage}`, {
              correlationId,
              from: wallet.address,
              method,
              txHash: state.hash,
              level: state.stage === 'failed' ? 'error' : 'info',
              message: state.error,
              context: state.errorName ? { reason: state.errorName } : undefined,
              metrics: {
                latencyMs: Date.now() - started,
                ...(state.gasUsed !== undefined ? { gasUsed: Number(state.gasUsed) } : {}),
              },
            });
          },
          context: { method, from: wallet.address },
        });

        tel.tx('tx.confirmed', {
          correlationId,
          from: wallet.address,
          method,
          txHash: receipt.hash,
          metrics: {
            gasUsed: Number(receipt.gasUsed),
            latencyMs: Date.now() - started,
            blockNumber: Number(receipt.blockNumber),
          },
        });

        await refreshEvents();
        return receipt.hash;
      } catch {
        // runTransaction reports every failure through onState -> tx.<stage>,
        // so the record already exists; do not log the same failure twice.
        return undefined;
      }
    },
    [wallet, tel, refreshEvents, networkMessage, contractReady, contractProblem],
  );

  return {
    wallet,
    connected: Boolean(wallet),
    connecting,
    connectError,
    networkOk,
    networkMessage,
    events,
    tx,
    alerts,
    telemetry,
    deploymentBlock,
    contractReady,
    contractProblem,
    connect,
    disconnect,
    refreshEvents,
    send,
    engine: engine.current,
  };
};

export { stageLabel, TX_STAGE_ORDER };
