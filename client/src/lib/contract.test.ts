import { describe, expect, it } from 'vitest';
import { hasContractCode } from './contract';

const provider = (code: string | Error) =>
  ({
    getCode: async () => {
      if (code instanceof Error) throw code;
      return code;
    },
  }) as any;

describe('contract availability probe', () => {
  it('reports true when the address holds bytecode', async () => {
    expect(await hasContractCode(provider('0x60806040'), '0xabc')).toBe(true);
  });

  it('reports false for an address without code', async () => {
    expect(await hasContractCode(provider('0x'), '0xabc')).toBe(false);
  });

  it('reports false when the RPC call fails', async () => {
    expect(await hasContractCode(provider(new Error('connect ECONNREFUSED')), '0xabc')).toBe(false);
  });

  it('reports false without a configured address', async () => {
    expect(await hasContractCode(provider('0x60806040'), undefined)).toBe(false);
  });
});
