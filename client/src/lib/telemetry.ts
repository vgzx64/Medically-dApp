/**
 * Structured telemetry for the dApp.
 *
 * Four categories of events are collected:
 *   contract  - logs emitted by the registry (ConsentRecorded / ConsentRevoked)
 *   tx       - transaction lifecycle (signing, sent, mined, reverted)
 *   rpc      - transport level errors and latency samples
 *   app      - user actions and application level notes
 *
 * Every record is a single JSON object written as JSONL. No secret material
 * (private keys, raw signatures, document contents) is ever recorded.
 */

export type TelemetryCategory = 'contract' | 'tx' | 'rpc' | 'app';

export type TelemetryLevel = 'debug' | 'info' | 'warn' | 'error';

export interface TelemetryRecord {
  /** ISO-8601 timestamp of the moment the record was produced. */
  ts: string;
  category: TelemetryCategory;
  level: TelemetryLevel;
  /** Short machine readable event name, e.g. "tx.reverted". */
  event: string;
  /** Correlates all records produced by one user action. */
  correlationId?: string;
  /** Monotonic counter: unique per record, used as the UI list key. */
  sequence?: number;
  chainId?: number;
  contractAddress?: string;
  txHash?: string;
  from?: string;
  to?: string;
  method?: string;
  /** Free-form numeric measurements (gas used, latency ms, ...). */
  metrics?: Record<string, number>;
  /** Free-form textual context. Must never contain secrets. */
  context?: Record<string, string | number | boolean | null>;
  message?: string;
}

export type TelemetrySink = (record: TelemetryRecord) => void;

/** Correlation id for one user action. */
export const newCorrelationId = (): string =>
  `corr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let counter = 0;

export class Telemetry {
  private readonly sink: TelemetrySink;

  private readonly base: Partial<TelemetryRecord>;

  constructor(sink: TelemetrySink, base: Partial<TelemetryRecord> = {}) {
    this.sink = sink;
    this.base = base;
  }

  private emit(record: Omit<TelemetryRecord, 'ts'>): void {
    counter += 1;
    this.sink({
      ...this.base,
      ...record,
      ts: new Date().toISOString(),
      sequence: counter,
    } as TelemetryRecord);
  }

  contract(event: string, data: Partial<TelemetryRecord> = {}): void {
    this.emit({ ...data, category: 'contract', level: data.level ?? 'info', event });
  }

  tx(event: string, data: Partial<TelemetryRecord> = {}): void {
    this.emit({ ...data, category: 'tx', level: data.level ?? 'info', event });
  }

  rpc(event: string, data: Partial<TelemetryRecord> = {}): void {
    this.emit({ ...data, category: 'rpc', level: data.level ?? 'info', event });
  }

  app(event: string, data: Partial<TelemetryRecord> = {}): void {
    this.emit({ ...data, category: 'app', level: data.level ?? 'info', event });
  }
}

/** Console sink, used in the browser. */
export const consoleSink: TelemetrySink = (record) => {
  // eslint-disable-next-line no-console
  console.info('[telemetry]', JSON.stringify(record));
};

/**
 * In-memory sink that keeps the last N records - used by the UI (alert feed)
 * and by the headless monitoring demo.
 */
export class MemorySink {
  readonly records: TelemetryRecord[] = [];

  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  readonly sink: TelemetrySink = (record) => {
    this.records.push(record);
    if (this.records.length > this.limit) {
      this.records.splice(0, this.records.length - this.limit);
    }
  };
}
