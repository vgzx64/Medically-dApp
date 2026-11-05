import { MemorySink, Telemetry, newCorrelationId } from './telemetry';

describe('telemetry', () => {
  it('stamps a unique sequence on every record (used as the UI key)', () => {
    const sink = new MemorySink(10);
    const tel = new Telemetry(sink.sink);

    for (let i = 0; i < 20; i += 1) tel.tx('tx.started', { method: 'registerConsent' });

    expect(sink.records).toHaveLength(10);
    const sequences = sink.records.map((r) => r.sequence);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('carries the correlation id and the base metadata', () => {
    const sink = new MemorySink();
    const tel = new Telemetry(sink.sink, { chainId: 31337, contractAddress: '0xregistry' });
    const correlationId = newCorrelationId();

    tel.tx('tx.confirmed', { correlationId, txHash: '0xhash', metrics: { gasUsed: 149_001 } });

    const [record] = sink.records;
    expect(record.correlationId).toBe(correlationId);
    expect(record.chainId).toBe(31337);
    expect(record.contractAddress).toBe('0xregistry');
    expect(record.metrics?.gasUsed).toBe(149_001);
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('never records key material', () => {
    const sink = new MemorySink();
    const tel = new Telemetry(sink.sink);
    tel.app('wallet.connected', { from: '0xactor', context: { mode: 'dev', label: 'Dev wallet' } });

    const serialised = JSON.stringify(sink.records);
    expect(serialised).not.toMatch(/privatekey|private_key|mnemonic|password|secret/i);
    expect(serialised).not.toMatch(/0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80/);
  });
});