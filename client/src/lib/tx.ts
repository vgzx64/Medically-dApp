/**
 * Transaction lifecycle state machine.
 *
 *   idle -> awaiting_signature -> signing -> sent -> pending
 *                                              -> confirmed
 *                                              -> failed
 *
 * Every transition is reported through the callback so that the UI and the
 * telemetry subsystem observe exactly the same sequence.
 */

import { ContractTransactionResponse, TransactionReceipt, Interface } from 'ethers';
import { isUserRejection } from './wallet';

export type TxStage =
  | 'idle'
  | 'awaiting_signature'
  | 'signing'
  | 'sent'
  | 'pending'
  | 'confirmed'
  | 'failed';

export interface TxState {
  stage: TxStage;
  hash?: string;
  /** Human readable description of the current stage. */
  message?: string;
  error?: string;
  /** Decoded custom error name, when the revert reason could be decoded. */
  errorName?: string;
  gasUsed?: bigint;
  blockNumber?: number;
}

export const initialTxState: TxState = { stage: 'idle' };

export interface DecodedError {
  name: string;
  args: string[];
}

/**
 * Decode a contract revert into a readable custom error.
 * Works both for a reverted call (data available) and for a receipt with a
 * `revertReason` string.
 */
export const decodeRevert = (
  iface: Interface,
  data: string | null | undefined,
  fallbackReason?: string,
): DecodedError | undefined => {
  if (data && data.length >= 10) {
    try {
      const parsed = iface.parseError(data);
      if (parsed) {
        return {
          name: parsed.name,
          args: parsed.args.map((a) => String(a)),
        };
      }
    } catch {
      // not a custom error of this contract - fall through
    }
  }
  if (fallbackReason) {
    return { name: 'Revert', args: [fallbackReason] };
  }
  return undefined;
};

export interface TxRunnerOptions {
  iface: Interface;
  onState: (state: TxState) => void;
  /** Timeout for the mining of the transaction, in milliseconds. */
  timeoutMs?: number;
  /** Poll interval while waiting for the receipt. */
  pollMs?: number;
}

export interface TxRunner {
  /** Send a write transaction and follow it until it is mined. */
  run(
    action: () => Promise<ContractTransactionResponse>,
    context: { method: string; from?: string },
  ): Promise<TransactionReceipt>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Send a transaction and drive it through the full lifecycle, reporting
 * every stage to the caller.
 */
export const runTransaction = async (
  action: () => Promise<ContractTransactionResponse>,
  options: TxRunnerOptions & { context: { method: string; from?: string } },
): Promise<TransactionReceipt> => {
  const { iface, onState } = options;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const pollMs = options.pollMs ?? 500;

  onState({ stage: 'awaiting_signature', message: 'Waiting for the wallet signature' });

  let response: ContractTransactionResponse;
  try {
    response = await action();
  } catch (error) {
    if (isUserRejection(error)) {
      const state: TxState = {
        stage: 'failed',
        error: 'The signature was rejected in the wallet',
        errorName: 'USER_REJECTED',
      };
      onState(state);
      throw new Error(state.error);
    }

    // A revert during the gas estimation carries the custom error data.
    const revertData = extractRevertData(error);
    const decoded = decodeRevert(iface, revertData);
    const state: TxState = {
      stage: 'failed',
      error: decoded
        ? `Reverted: ${decoded.name}(${decoded.args.join(', ')})`
        : error instanceof Error
          ? error.message
          : String(error),
      errorName: decoded?.name ?? 'TX_SEND_FAILED',
    };
    onState(state);
    throw new Error(state.error);
  }

  const hash = response.hash;
  onState({ stage: 'signing', hash, message: 'Transaction signed and broadcast' });
  onState({ stage: 'sent', hash, message: 'Transaction sent to the network' });

  const started = Date.now();
  let receipt: TransactionReceipt | null = null;

  while (Date.now() - started < timeoutMs) {
    receipt = await response.wait(1);
    if (receipt) break;
    onState({ stage: 'pending', hash, message: 'Waiting for the transaction to be mined' });
    await wait(pollMs);
  }

  if (!receipt) {
    const state: TxState = {
      stage: 'failed',
      hash,
      error: `The transaction was not mined within ${timeoutMs / 1000}s`,
      errorName: 'TX_TIMEOUT',
    };
    onState(state);
    throw new Error(state.error);
  }

  if (receipt.status === 0) {
    const revertData = await findRevertData(response);
    const decoded = decodeRevert(iface, revertData);
    const state: TxState = {
      stage: 'failed',
      hash,
      error: decoded
        ? `Reverted: ${decoded.name}(${decoded.args.join(', ')})`
        : 'The transaction was reverted by the contract',
      errorName: decoded?.name ?? 'REVERTED',
      gasUsed: receipt.gasUsed,
      blockNumber: receipt.blockNumber,
    };
    onState(state);
    throw new Error(state.error);
  }

  onState({
    stage: 'confirmed',
    hash,
    message: 'Transaction confirmed',
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
  });

  return receipt;
};

/** Extract the revert data from an ethers error object. */
export const extractRevertData = (error: unknown): string | undefined => {
  const err = error as {
    data?: string;
    revert?: { data?: string };
    error?: { data?: string };
    info?: { error?: { data?: string } };
  };
  const data = err?.data ?? err?.revert?.data ?? err?.error?.data ?? err?.info?.error?.data;
  return data && data !== '0x' ? data : undefined;
};

/**
 * Re-run the failed transaction with a static call to obtain the revert data.
 * `eth_call` on a mined transaction still returns the original revert payload.
 */
const findRevertData = async (
  response: ContractTransactionResponse,
): Promise<string | undefined> => {
  try {
    const provider = response.provider;
    if (!provider) return undefined;
    const data = await provider.call({
      to: response.to,
      from: response.from,
      data: response.data,
      blockTag: 'latest',
    });
    return data && data !== '0x' ? data : undefined;
  } catch (error) {
    // The revert data is embedded in the error object by ethers v6.
    return extractRevertData(error);
  }
};

/** Human readable label for a stage. */
export const stageLabel: Record<TxStage, string> = {
  idle: 'Idle',
  awaiting_signature: 'Awaiting signature',
  signing: 'Signing',
  sent: 'Sent',
  pending: 'Pending',
  confirmed: 'Confirmed',
  failed: 'Failed',
};
