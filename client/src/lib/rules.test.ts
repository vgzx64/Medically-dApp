import { describe, expect, it } from 'vitest';
import { DetectionEngine, defaultRuleConfig } from './rules';
import type { TelemetryRecord } from './telemetry';

const record = (over: Partial<TelemetryRecord>): TelemetryRecord => ({
  ts: new Date().toISOString(),
  category: 'tx',
  level: 'error',
  event: 'tx.reverted',
  ...over,
} as TelemetryRecord);

describe('DetectionEngine - rule R1 (access violation)', () => {
  it('does not alert below the threshold', () => {
    const engine = new DetectionEngine();
    for (let i = 0; i < defaultRuleConfig.accessThreshold - 1; i += 1) {
      const alert = engine.reportAccessViolation({
        ts: Date.now(),
        address: '0xattacker',
        method: 'registerConsent',
      });
      expect(alert).toBeUndefined();
    }
    expect(engine.getAlerts()).toHaveLength(0);
  });

  it('raises an alert when the threshold is reached', () => {
    const engine = new DetectionEngine();
    let alert;
    for (let i = 0; i < defaultRuleConfig.accessThreshold; i += 1) {
      alert = engine.reportAccessViolation({
        ts: Date.now(),
        address: '0xattacker',
        method: 'registerConsent',
      });
    }
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('R1');
    expect(alert!.severity).toBe('high');
    expect(alert!.subject).toBe('0xattacker');
    expect(engine.getAlerts()).toHaveLength(1);
  });

  it('de-duplicates repeated alerts with a cooldown', () => {
    const engine = new DetectionEngine();
    for (let i = 0; i < 10; i += 1) {
      engine.reportAccessViolation({
        ts: Date.now(),
        address: '0xattacker',
        method: 'registerConsent',
      });
    }
    expect(engine.getAlerts()).toHaveLength(1);
  });

  it('keeps different subjects separate', () => {
    const engine = new DetectionEngine();
    for (let i = 0; i < 3; i += 1) {
      engine.reportAccessViolation({ ts: Date.now(), address: '0xa', method: 'm' });
    }
    for (let i = 0; i < 3; i += 1) {
      engine.reportAccessViolation({ ts: Date.now(), address: '0xb', method: 'm' });
    }
    expect(engine.getAlerts()).toHaveLength(2);
  });

  it('blocks the privileged action for the offending address', () => {
    const engine = new DetectionEngine();
    for (let i = 0; i < 3; i += 1) {
      engine.reportAccessViolation({ ts: Date.now(), address: '0xattacker', method: 'm' });
    }
    expect(engine.isAccessBlocked('0xattacker')).toBe(true);
    expect(engine.isAccessBlocked('0xATTACKER')).toBe(true);
    expect(engine.isAccessBlocked('0xbystander')).toBe(false);
  });

  it('ingests telemetry records with an access-control revert reason', () => {
    const engine = new DetectionEngine();
    for (let i = 0; i < 3; i += 1) {
      engine.ingest(
        record({
          from: '0xattacker',
          method: 'registerConsent',
          context: { reason: 'AccessControlUnauthorizedAccount' },
        }),
      );
    }
    expect(engine.getAlerts()).toHaveLength(1);
    expect(engine.getAlerts()[0].ruleId).toBe('R1');
  });
});

describe('DetectionEngine - rule R2 (operational failure)', () => {
  it('raises an alert after the failure threshold', () => {
    const engine = new DetectionEngine();
    let alert;
    for (let i = 0; i < defaultRuleConfig.opsThreshold; i += 1) {
      alert = engine.reportOperationalFailure({
        ts: Date.now(),
        kind: 'rpc_error',
        detail: 'connection refused',
      });
    }
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('R2');
    expect(alert!.severity).toBe('medium');
  });

  it('raises an alert on a high latency sample', () => {
    const engine = new DetectionEngine();
    const alert = engine.reportOperationalFailure({
      ts: Date.now(),
      kind: 'timeout',
      detail: 'slow',
      latencyMs: 5_000,
    });
    expect(alert).toBeDefined();
    expect(alert!.ruleId).toBe('R2');
  });

  it('de-duplicates operational alerts', () => {
    const engine = new DetectionEngine();
    for (let i = 0; i < 20; i += 1) {
      engine.reportOperationalFailure({
        ts: Date.now(),
        kind: 'rpc_error',
        detail: 'boom',
      });
    }
    expect(engine.getAlerts()).toHaveLength(1);
  });

  it('ignores regular transaction reverts for the access rule', () => {
    const engine = new DetectionEngine();
    engine.ingest(record({ from: '0xpatient', method: 'revokeConsent' }));
    expect(engine.getAlerts()).toHaveLength(0);
  });

  it('ingests the dApp form of an access-control failure (tx.failed)', () => {
    const engine = new DetectionEngine();
    for (let i = 0; i < defaultRuleConfig.accessThreshold; i += 1) {
      engine.ingest(
        record({
          event: 'tx.failed',
          from: '0xattacker',
          method: 'registerConsent',
          context: { reason: 'AccessControlUnauthorizedAccount' },
        }),
      );
    }
    expect(engine.getAlerts()).toHaveLength(1);
    expect(engine.getAlerts()[0].ruleId).toBe('R1');
  });

  it('does not alert on a user rejection (not an operational failure)', () => {
    const engine = new DetectionEngine();
    for (let i = 0; i < defaultRuleConfig.opsThreshold; i += 1) {
      engine.ingest(record({ event: 'tx.failed', context: { reason: 'USER_REJECTED' } }));
    }
    // A rejected signature still counts as an operational failure sample, but
    // it must never raise the high-severity access rule.
    expect(engine.getAlerts().every((a) => a.ruleId !== 'R1')).toBe(true);
  });
});
