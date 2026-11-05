import { describe, expect, it } from 'vitest';
import { Interface } from 'ethers';
import { REGISTRY_ABI } from './abi';
import { decodeRevert, extractRevertData, runTransaction, type TxState } from './tx';

const iface = new Interface(REGISTRY_ABI);

const ADDRESS_A = '0x' + '11'.repeat(20);
const ADDRESS_B = '0x' + '22'.repeat(20);
const CONSENT_ID = '0x' + '33'.repeat(32);

const errorData = (name: string, args: unknown[] = []): string =>
  iface.encodeErrorResult(name, args);

describe('transaction lifecycle', () => {
  it('reports the full sequence of stages on success', async () => {
    const stages: string[] = [];
    const receipt = {
      hash: '0xdeadbeef',
      status: 1,
      gasUsed: 21_000n,
      blockNumber: 7,
    } as any;

    const result = await runTransaction(
      async () => ({ hash: '0xdeadbeef', wait: async () => receipt }) as any,
      {
        iface,
        onState: (s: TxState) => stages.push(s.stage),
        context: { method: 'registerConsent' },
      },
    );

    expect(result.hash).toBe('0xdeadbeef');
    expect(stages[0]).toBe('awaiting_signature');
    expect(stages).toContain('sent');
    expect(stages[stages.length - 1]).toBe('confirmed');
  });

  it('marks the transaction as failed when the receipt status is 0', async () => {
    const stages: TxState[] = [];
    const receipt = { hash: '0xbad', status: 0, gasUsed: 1n, blockNumber: 1 } as any;

    await expect(
      runTransaction(async () => ({ hash: '0xbad', wait: async () => receipt }) as any, {
        iface,
        onState: (s: TxState) => stages.push(s),
        context: { method: 'revokeConsent' },
      }),
    ).rejects.toThrow();

    const last = stages[stages.length - 1];
    expect(last.stage).toBe('failed');
  });

  it('decodes a custom error raised during the gas estimation', async () => {
    const stages: TxState[] = [];
    const revert = Object.assign(new Error('execution reverted'), {
      data: errorData('ConsentAlreadyExists', [CONSENT_ID]),
    });

    await expect(
      runTransaction(async () => {
        throw revert;
      }, {
        iface,
        onState: (s: TxState) => stages.push(s),
        context: { method: 'registerConsent' },
      }),
    ).rejects.toThrow(/ConsentAlreadyExists/);

    const last = stages[stages.length - 1];
    expect(last.stage).toBe('failed');
    expect(last.errorName).toBe('ConsentAlreadyExists');
  });

  it('treats a wallet rejection as a specific failure', async () => {
    const stages: TxState[] = [];
    const rejected = Object.assign(new Error('user rejected transaction'), { code: 4001 });

    await expect(
      runTransaction(async () => {
        throw rejected;
      }, {
        iface,
        onState: (s: TxState) => stages.push(s),
        context: { method: 'registerConsent' },
      }),
    ).rejects.toThrow(/rejected/i);

    const last = stages[stages.length - 1];
    expect(last.stage).toBe('failed');
    expect(last.errorName).toBe('USER_REJECTED');
  });

  it('times out when the transaction is never mined', async () => {
    const stages: TxState[] = [];
    await expect(
      runTransaction(async () => ({ hash: '0x1', wait: async () => null }) as any, {
        iface,
        onState: (s: TxState) => stages.push(s),
        context: { method: 'registerConsent' },
        timeoutMs: 50,
        pollMs: 10,
      }),
    ).rejects.toThrow(/not mined/);

    expect(stages[stages.length - 1].errorName).toBe('TX_TIMEOUT');
  });
});

describe('revert data extraction', () => {
  it('reads the data from the top level of the error', () => {
    const data = '0x45a906b2';
    expect(extractRevertData({ data })).toBe(data);
  });

  it('reads the data from error.info.error.data', () => {
    const data = '0x45a906b2';
    expect(extractRevertData({ info: { error: { data } } })).toBe(data);
  });

  it('ignores an empty revert payload', () => {
    expect(extractRevertData({ data: '0x' })).toBeUndefined();
    expect(extractRevertData(undefined)).toBeUndefined();
  });
});

describe('revert decoding', () => {
  it('decodes a custom error', () => {
    const decoded = decodeRevert(iface, errorData('NotConsentOwner', [ADDRESS_A, ADDRESS_B]));
    expect(decoded).toBeDefined();
    expect(decoded!.name).toBe('NotConsentOwner');
    expect(decoded!.args).toHaveLength(2);
  });

  it('decodes a custom error without arguments', () => {
    const decoded = decodeRevert(iface, errorData('InvalidSignature'));
    expect(decoded!.name).toBe('InvalidSignature');
  });

  it('falls back to the revert reason string', () => {
    const decoded = decodeRevert(iface, null, 'execution reverted');
    expect(decoded!.name).toBe('Revert');
    expect(decoded!.args[0]).toBe('execution reverted');
  });

  it('returns undefined for unknown data', () => {
    expect(decodeRevert(iface, null)).toBeUndefined();
  });
});
