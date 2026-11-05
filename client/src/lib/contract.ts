import type { Provider } from 'ethers';

export interface ContractVerification {
  address: string;
  exists: boolean;
  matches: boolean;
  codeHash: string;
  expectedHash: string;
}

/**
 * Contract verification utilities.
 *
 * What we can verify on-chain:
 *  - `exists`: the address has non-empty code (not "0x")
 *  - `matches`: the deployed code hash equals the expected hash from the
 *    compiled artifact in this repository
 *
 * What we can NOT verify:
 *  - The source file keccak256 hash (stored in the repo, not on-chain).
 *    The source hash is a build-time checksum; the deployed bytecode is
 *    what we can actually read from the chain.
 */
export const getDeployedCodeHash = async (provider: Provider, address: string): Promise<string | undefined> => {
  try {
    const code = await provider.getCode(address);
    return code === '0x' ? undefined : code;
  } catch {
    return undefined;
  }
};

/**
 * True when the configured address holds bytecode on the connected network.
 * Used before the UI offers any action, so a stale address shows a banner
 * instead of silently empty panels.
 */
export const hasContractCode = async (
  provider: Provider,
  address: string | undefined,
): Promise<boolean> => {
  if (!address) return false;
  return (await getDeployedCodeHash(provider, address)) !== undefined;
};

export const verifyContract = async (
  provider: Provider,
  address: string,
  expectedHash: string,
): Promise<ContractVerification> => {
  const codeHash = await getDeployedCodeHash(provider, address);
  return {
    address,
    exists: codeHash !== undefined,
    matches: codeHash === expectedHash,
    codeHash: codeHash ?? '0x',
    expectedHash,
  };
};
