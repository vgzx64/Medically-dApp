/**
 * Event log handling: backfill from the deployment block, live subscription
 * and de-duplication.
 *
 * The de-duplication key is `txHash:logIndex` - the same event can be
 * delivered twice (once by the backfill query and once by the subscription),
 * and the UI must show it only once.
 */

import { Contract, Interface, type Log, type Provider } from 'ethers';

export interface ConsentRecordedEvent {
  kind: 'recorded';
  consentId: string;
  patient: string;
  issuer: string;
  consentHash: string;
  version: number;
  expiresAt: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  key: string;
}

export interface ConsentRevokedEvent {
  kind: 'revoked';
  consentId: string;
  patient: string;
  revokedBy: string;
  revokedAt: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  key: string;
}

export interface RegistrarUpdatedEvent {
  kind: 'registrar';
  registrar: string;
  enabled: boolean;
  by: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  key: string;
}

export interface ContractPausedEvent {
  kind: 'paused';
  by: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  key: string;
}

export interface ContractUnpausedEvent {
  kind: 'unpaused';
  by: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  key: string;
}

export type ConsentEvent =
  | ConsentRecordedEvent
  | ConsentRevokedEvent
  | RegistrarUpdatedEvent
  | ContractPausedEvent
  | ContractUnpausedEvent;

export const eventKey = (txHash: string, logIndex: number): string => `${txHash}:${logIndex}`;

/** Convert a raw log into a typed consent event. */
export const decodeConsentEvent = (
  iface: Interface,
  log: Log,
  timestamp: number,
): ConsentEvent | undefined => {
  let parsed;
  try {
    parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
  } catch {
    return undefined;
  }
  if (!parsed) return undefined;

  const key = eventKey(log.transactionHash, log.index);

  if (parsed.name === 'ConsentRecorded') {
    return {
      kind: 'recorded',
      consentId: String(parsed.args.consentId),
      patient: String(parsed.args.patient),
      issuer: String(parsed.args.issuer),
      consentHash: String(parsed.args.consentHash),
      version: Number(parsed.args.version),
      expiresAt: Number(parsed.args.expiresAt),
      txHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: log.blockNumber,
      timestamp,
      key,
    };
  }

  if (parsed.name === 'ConsentRevoked') {
    return {
      kind: 'revoked',
      consentId: String(parsed.args.consentId),
      patient: String(parsed.args.patient),
      revokedBy: String(parsed.args.revokedBy),
      revokedAt: Number(parsed.args.revokedAt),
      txHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: log.blockNumber,
      timestamp,
      key,
    };
  }

  if (parsed.name === 'RegistrarUpdated') {
    return {
      kind: 'registrar',
      registrar: String(parsed.args.registrar),
      enabled: Boolean(parsed.args.enabled),
      by: String(parsed.args.by),
      txHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: log.blockNumber,
      timestamp,
      key,
    };
  }

  if (parsed.name === 'ContractPaused') {
    return {
      kind: 'paused',
      by: String(parsed.args.by),
      txHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: log.blockNumber,
      timestamp,
      key,
    };
  }

  if (parsed.name === 'ContractUnpaused') {
    return {
      kind: 'unpaused',
      by: String(parsed.args.by),
      txHash: log.transactionHash,
      logIndex: log.index,
      blockNumber: log.blockNumber,
      timestamp,
      key,
    };
  }

  return undefined;
};

/**
 * Load the historical events of the registry starting from `fromBlock`.
 * The result is ordered from the newest to the oldest event.
 */
export const backfillEvents = async (
  contract: Contract,
  iface: Interface,
  provider: Provider,
  fromBlock: number,
  toBlock: number | 'latest' = 'latest',
): Promise<ConsentEvent[]> => {
  const filter = contract.filters.ConsentRecorded();
  const filterRevoked = contract.filters.ConsentRevoked();
  const filterRegistrar = contract.filters.RegistrarUpdated();
  const filterPaused = contract.filters.ContractPaused();
  const filterUnpaused = contract.filters.ContractUnpaused();

  // `queryFilter` keeps the fragment topics; spreading a Filter into
  // `provider.getLogs({ ...filter })` drops them, because `topics` and
  // `address` live on the prototype - every query would then return all logs.
  const [recorded, revoked, registrar, paused, unpaused] = await Promise.all([
    contract.queryFilter(filter, fromBlock, toBlock),
    contract.queryFilter(filterRevoked, fromBlock, toBlock),
    contract.queryFilter(filterRegistrar, fromBlock, toBlock),
    contract.queryFilter(filterPaused, fromBlock, toBlock),
    contract.queryFilter(filterUnpaused, fromBlock, toBlock),
  ]);

  const all = [...recorded, ...revoked, ...registrar, ...paused, ...unpaused];
  const blockNumbers = [...new Set(all.map((l) => l.blockNumber))];
  const timestamps = await loadBlockTimestamps(provider, blockNumbers);

  const events = [...uniqueLogs(all)]
    .map((log) => decodeConsentEvent(iface, log, timestamps.get(log.blockNumber) ?? 0))
    .filter((e): e is ConsentEvent => e !== undefined);

  return sortEvents(events);
};

/** De-duplicate raw logs by the `txHash:logIndex` key used by the UI. */
const uniqueLogs = (logs: Log[]): Set<Log> => {
  const byKey = new Map<string, Log>();
  for (const log of logs) byKey.set(eventKey(log.transactionHash, log.index), log);
  return new Set(byKey.values());
};

/** Fetch the timestamps of the given blocks (used to date the events). */
export const loadBlockTimestamps = async (
  provider: Provider,
  blockNumbers: number[],
): Promise<Map<number, number>> => {
  const result = new Map<number, number>();
  const unique = [...new Set(blockNumbers)].filter((n) => Number.isFinite(n));

  const blocks = await Promise.all(
    unique.map(async (n) => {
      try {
        const block = await provider.getBlock(n);
        return [n, Number(block?.timestamp ?? 0)] as const;
      } catch {
        return [n, 0] as const;
      }
    }),
  );

  for (const [number, timestamp] of blocks) {
    result.set(number, timestamp);
  }
  return result;
};

/** Newest first. */
export const sortEvents = (events: ConsentEvent[]): ConsentEvent[] =>
  [...events].sort((a, b) => {
    if (b.blockNumber !== a.blockNumber) return b.blockNumber - a.blockNumber;
    return b.logIndex - a.logIndex;
  });

/**
 * Merge a batch of events into an existing list, removing duplicates by
 * `txHash:logIndex` and keeping the list sorted.
 */
export const mergeEvents = (
  existing: ConsentEvent[],
  incoming: ConsentEvent[],
): ConsentEvent[] => {
  // A Map de-duplicates against `existing` and within `incoming` in one pass.
  const byKey = new Map<string, ConsentEvent>();
  for (const e of existing) byKey.set(e.key, e);
  for (const e of incoming) if (!byKey.has(e.key)) byKey.set(e.key, e);
  return sortEvents([...byKey.values()]);
};
