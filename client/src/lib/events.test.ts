import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import { REGISTRY_ABI } from './abi';
import { decodeConsentEvent, eventKey, mergeEvents, sortEvents, backfillEvents } from './events';

const iface = new Interface(REGISTRY_ABI);

const makeLog = (over: Partial<any> = {}) => ({
  topics: [],
  data: '0x',
  transactionHash: '0xhash',
  index: 0,
  blockNumber: 1,
  ...over,
});

describe('event decoding', () => {
  it('decodes ConsentRecorded', () => {
    const fragment = iface.getEvent('ConsentRecorded')!;
    const log = iface.encodeEventLog(fragment, [
      '0x' + '11'.repeat(32),
      '0x' + '22'.repeat(20),
      '0x' + '33'.repeat(20),
      '0x' + '44'.repeat(32),
      2,
      1700000000,
    ]);

    const event = decodeConsentEvent(
      iface,
      { ...makeLog(), ...log } as any,
      1699999999,
    );

    expect(event).toBeDefined();
    expect(event!.kind).toBe('recorded');
    if (event!.kind === 'recorded') {
      expect(event!.version).toBe(2);
      expect(event!.expiresAt).toBe(1700000000);
      expect(event!.patient.toLowerCase()).toBe('0x' + '22'.repeat(20));
    }
    expect(event!.key).toBe(eventKey('0xhash', 0));
  });

  it('decodes ConsentRevoked', () => {
    const fragment = iface.getEvent('ConsentRevoked')!;
    const log = iface.encodeEventLog(fragment, [
      '0x' + '11'.repeat(32),
      '0x' + '22'.repeat(20),
      '0x' + '33'.repeat(20),
      1700000001,
    ]);

    const event = decodeConsentEvent(
      iface,
      { ...makeLog({ index: 3 }), ...log } as any,
      1700000002,
    );

    expect(event).toBeDefined();
    expect(event!.kind).toBe('revoked');
    if (event!.kind === 'revoked') {
      expect(event!.revokedAt).toBe(1700000001);
    }
    expect(event!.key).toBe('0xhash:3');
  });

  it('ignores unknown logs', () => {
    const event = decodeConsentEvent(iface, makeLog() as any, 0);
    expect(event).toBeUndefined();
  });
});

describe('event de-duplication', () => {
  const event = (key: string, blockNumber: number) =>
    ({
      kind: 'recorded',
      consentId: '0xid',
      patient: '0xpatient',
      issuer: '0xissuer',
      consentHash: '0xhash',
      version: 1,
      expiresAt: 0,
      txHash: '0xtx',
      logIndex: Number(key.split(':')[1]),
      blockNumber,
      timestamp: blockNumber,
      key,
    }) as any;

  it('removes duplicates by txHash:logIndex', () => {
    const merged = mergeEvents([event('0xa:1', 1)], [event('0xa:1', 1), event('0xb:2', 2)]);
    expect(merged).toHaveLength(2);
  });

  it('keeps the list sorted from the newest to the oldest', () => {
    const merged = mergeEvents([], [event('0xa:1', 1), event('0xc:3', 3), event('0xb:2', 2)]);
    expect(merged.map((e) => e.blockNumber)).toEqual([3, 2, 1]);
  });

  it('is idempotent', () => {
    const first = mergeEvents([], [event('0xa:1', 1)]);
    const second = mergeEvents(first, [event('0xa:1', 1)]);
    expect(second).toHaveLength(1);
  });

  it('sorts stably for the same block', () => {
    const sorted = sortEvents([event('0xa:1', 5), event('0xa:7', 5)]);
    expect(sorted[0].key).toBe('0xa:7');
  });

  it('removes duplicates inside a single incoming batch', () => {
    const merged = mergeEvents([], [event('0xa:1', 1), event('0xa:1', 1), event('0xb:2', 2)]);
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.key)).toEqual(['0xb:2', '0xa:1']);
  });
});

describe('event backfill', () => {
  // One ConsentRecorded log, as Anvil would return it.
  const recordedLog = () => {
    const fragment = iface.getEvent('ConsentRecorded')!;
    const encoded = iface.encodeEventLog(fragment, [
      '0x' + '11'.repeat(32),
      '0x' + '22'.repeat(20),
      '0x' + '33'.repeat(20),
      '0x' + '44'.repeat(32),
      1,
      0,
    ]);
    return {
      ...encoded,
      transactionHash: '0xaaa',
      index: 0,
      blockNumber: 5,
    } as any;
  };

  it('returns every log once when all filters return the same log set', async () => {
    // Regression guard: spreading an ethers Filter into provider.getLogs drops
    // its topics, so each of the five queries returned the whole log set and
    // the UI showed the same event five times.
    const log = recordedLog();
    const contract = {
      filters: {
        ConsentRecorded: () => ({}),
        ConsentRevoked: () => ({}),
        RegistrarUpdated: () => ({}),
        ContractPaused: () => ({}),
        ContractUnpaused: () => ({}),
      },
      queryFilter: async () => [log],
    };
    const provider = { getBlock: async (n: number) => ({ timestamp: 1_700_000_000 + n }) };

    const events = await backfillEvents(contract as any, iface, provider as any, 0);

    expect(events).toHaveLength(1);
    expect(events[0].key).toBe(eventKey('0xaaa', 0));
    expect(events[0].blockNumber).toBe(5);
  });
});
