/**
 * Detection rules for the monitoring subsystem.
 *
 * R1 - access violation: repeated unauthorized attempts to call a privileged
 *      function. Source: transaction receipts + application logs.
 *      Threshold: >= 3 attempts from one address within 60 seconds.
 *      Severity: High. Reaction: raise an alert and disable the privileged
 *      action in the UI until an operator acknowledges it.
 *
 * R2 - operational failure: transport level problems. Source: RPC errors,
 *      reverted transactions and latency samples.
 *      Threshold: >= 5 failures within 5 minutes, or p95 latency > 2000 ms.
 *      Severity: Medium. Reaction: raise an alert, keep the UI usable and
 *      advise the operator to check the RPC endpoint.
 *
 * Both rules are evaluated over a rolling time window and de-duplicate their
 * alerts by a fingerprint (rule + subject) with a cooldown, so a single
 * incident does not flood the alert feed.
 */

import type { TelemetryRecord } from './telemetry';

export type Severity = 'low' | 'medium' | 'high';

export interface Alert {
  id: string;
  ruleId: string;
  severity: Severity;
  title: string;
  description: string;
  /** Object the alert is about (address, method, endpoint...). */
  subject: string;
  /** ISO timestamp of the moment the alert was raised. */
  raisedAt: string;
  /** Measured value that triggered the rule. */
  value: number;
  threshold: number;
  /** Recommended operator reaction. */
  reaction: string;
  fingerprint: string;
}

export interface RuleConfig {
  /** R1: window and threshold for unauthorized attempts. */
  accessWindowMs: number;
  accessThreshold: number;
  accessSeverity: Severity;
  /** R2: window and threshold for operational failures. */
  opsWindowMs: number;
  opsThreshold: number;
  opsLatencyThresholdMs: number;
  opsSeverity: Severity;
  /** Minimum time between two identical alerts. */
  cooldownMs: number;
}

export const defaultRuleConfig: RuleConfig = {
  accessWindowMs: 60_000,
  accessThreshold: 3,
  accessSeverity: 'high',
  opsWindowMs: 5 * 60_000,
  opsThreshold: 5,
  opsLatencyThresholdMs: 2_000,
  opsSeverity: 'medium',
  cooldownMs: 5 * 60_000,
};

/** A transaction that was rejected by the access control of the contract. */
export interface AccessViolationSample {
  ts: number;
  address: string;
  method: string;
  txHash?: string;
}

/** A transport level failure. */
export interface OperationalFailureSample {
  ts: number;
  kind: 'rpc_error' | 'tx_reverted' | 'timeout';
  detail: string;
  latencyMs?: number;
  txHash?: string;
}

const now = (): number => Date.now();

/** Simple rolling-window counter over timestamped samples. */
class Window<T extends { ts: number }> {
  private items: T[] = [];

  private readonly windowMs: number;

  constructor(windowMs: number) {
    this.windowMs = windowMs;
  }

  push(item: T): void {
    this.items.push(item);
    this.trim();
  }

  private trim(): void {
    const cutoff = now() - this.windowMs;
    while (this.items.length > 0 && this.items[0].ts < cutoff) {
      this.items.shift();
    }
  }

  all(): T[] {
    this.trim();
    return [...this.items];
  }

  get size(): number {
    this.trim();
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }
}

export class DetectionEngine {
  private readonly violations = new Map<string, Window<AccessViolationSample>>();

  private readonly failures: Window<OperationalFailureSample>;

  private readonly latencies: Window<OperationalFailureSample>;

  private readonly alerts: Alert[] = [];

  private readonly lastRaised = new Map<string, number>();

  private readonly config: RuleConfig;

  constructor(config: RuleConfig = defaultRuleConfig) {
    this.config = config;
    this.failures = new Window<OperationalFailureSample>(this.config.opsWindowMs);
    this.latencies = new Window<OperationalFailureSample>(this.config.opsWindowMs);
  }

  /** Feed an unauthorized access attempt into R1. */
  reportAccessViolation(sample: AccessViolationSample): Alert | undefined {
    const key = sample.address.toLowerCase();
    let window = this.violations.get(key);
    if (!window) {
      window = new Window<AccessViolationSample>(this.config.accessWindowMs);
      this.violations.set(key, window);
    }
    window.push(sample);

    if (window.size < this.config.accessThreshold) {
      return undefined;
    }

    const fingerprint = `R1:${key}`;
    return this.raise({
      fingerprint,
      ruleId: 'R1',
      severity: this.config.accessSeverity,
      title: 'Access violation detected',
      description:
        `${window.size} unauthorized attempts to a privileged function ` +
        `(${sample.method}) from ${sample.address} within ` +
        `${this.config.accessWindowMs / 1000}s.`,
      subject: sample.address,
      value: window.size,
      threshold: this.config.accessThreshold,
      reaction: 'Disable the privileged action in the UI and notify the security operator.',
    });
  }

  /** Feed an operational failure into R2. */
  reportOperationalFailure(sample: OperationalFailureSample): Alert | undefined {
    this.failures.push(sample);
    if (sample.latencyMs !== undefined) {
      this.latencies.push({ ...sample, ts: sample.ts });
    }

    const failures = this.failures.size;
    const p95 = this.p95Latency();

    if (failures < this.config.opsThreshold && p95 <= this.config.opsLatencyThresholdMs) {
      return undefined;
    }

    const reason =
      failures >= this.config.opsThreshold
        ? `${failures} operational failures within ${this.config.opsWindowMs / 60000} min`
        : `p95 latency ${Math.round(p95)} ms exceeds ${this.config.opsLatencyThresholdMs} ms`;

    return this.raise({
      fingerprint: 'R2:rpc',
      ruleId: 'R2',
      severity: this.config.opsSeverity,
      title: 'Operational failure detected',
      description: `${reason}. Last error: ${sample.detail}`,
      subject: sample.kind,
      value: failures >= this.config.opsThreshold ? failures : Math.round(p95),
      threshold:
        failures >= this.config.opsThreshold
          ? this.config.opsThreshold
          : this.config.opsLatencyThresholdMs,
      reaction: 'Check the RPC endpoint health and the wallet provider status.',
    });
  }

  /** Ingest an arbitrary telemetry record (used by the demo runner). */
  ingest(record: TelemetryRecord): Alert | undefined {
    // The dApp reports a reverted transaction as `tx.failed` with the decoded
    // error in `context.reason`; the headless demo uses `tx.reverted`.
    const reverted = record.event === 'tx.reverted' || record.event === 'tx.failed';

    if (reverted && record.context?.reason === 'AccessControlUnauthorizedAccount') {
      const address = record.from ?? 'unknown';
      return this.reportAccessViolation({
        ts: Date.parse(record.ts),
        address,
        method: record.method ?? 'unknown',
        txHash: record.txHash,
      });
    }

    if (record.event === 'rpc.error' || reverted) {
      return this.reportOperationalFailure({
        ts: Date.parse(record.ts),
        kind: record.event === 'rpc.error' ? 'rpc_error' : 'tx_reverted',
        detail: record.message ?? record.event,
        txHash: record.txHash,
        latencyMs: record.metrics?.latencyMs,
      });
    }

    if (record.event === 'rpc.latency' && record.metrics?.latencyMs !== undefined) {
      return this.reportOperationalFailure({
        ts: Date.parse(record.ts),
        kind: 'rpc_error',
        detail: 'latency sample',
        latencyMs: record.metrics.latencyMs,
      });
    }

    return undefined;
  }

  private p95Latency(): number {
    const values = this.latencies
      .all()
      .map((s) => s.latencyMs ?? 0)
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    if (values.length === 0) return 0;
    const index = Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1);
    return values[Math.max(0, index)];
  }

  private raise(input: {
    fingerprint: string;
    ruleId: string;
    severity: Severity;
    title: string;
    description: string;
    subject: string;
    value: number;
    threshold: number;
    reaction: string;
  }): Alert | undefined {
    const last = this.lastRaised.get(input.fingerprint);
    const ts = now();
    if (last !== undefined && ts - last < this.config.cooldownMs) {
      return undefined; // de-duplicated by the cooldown
    }
    this.lastRaised.set(input.fingerprint, ts);

    const alert: Alert = {
      ...input,
      id: `${input.ruleId}-${ts}-${Math.random().toString(36).slice(2, 8)}`,
      raisedAt: new Date(ts).toISOString(),
    };
    this.alerts.push(alert);
    return alert;
  }

  /** All alerts raised so far. */
  getAlerts(): Alert[] {
    return [...this.alerts];
  }

  /** True if R1 currently blocks the privileged action for an address. */
  isAccessBlocked(address: string): boolean {
    const key = address.toLowerCase();
    const window = this.violations.get(key);
    if (!window) return false;
    return window.size >= this.config.accessThreshold;
  }

  /** Current failure count inside the operational window. */
  failureCount(): number {
    return this.failures.size;
  }

  reset(): void {
    this.violations.clear();
    this.failures.clear();
    this.latencies.clear();
    this.alerts.length = 0;
    this.lastRaised.clear();
  }
}
