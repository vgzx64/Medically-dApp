/**
 * Runtime configuration of the dApp.
 *
 * Values start from Vite env vars / built-in defaults, can be overridden by a
 * saved runtime config (localStorage) and by the in-app config panel, so the
 * same build works for both MetaMask/Sepolia and the local Anvil node.
 */

export interface AppConfig {
  rpcUrl: string;
  contractAddress: string | undefined;
  chainId: number;
  walletMode: 'injected' | 'dev';
  devPrivateKey: string;
  expectedBytecodeHash: string;
  registrarAddress: string | undefined;
}

const STORAGE_KEY = 'pcr.config';

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeMode = (value: unknown): 'injected' | 'dev' =>
  value === 'dev' ? 'dev' : 'injected';

export const ANVIL_PRESET: Partial<AppConfig> = {
  rpcUrl: 'http://127.0.0.1:8545',
  chainId: 31337,
  walletMode: 'dev',
  expectedBytecodeHash: '0x26b252b35232d0e9e81939132133c1305283ab3757c70f0ffed8ae22aeac3c73',
  devPrivateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
};

export const SEPOLIA_PRESET: Partial<AppConfig> = {
  chainId: 11155111,
  walletMode: 'injected',
  expectedBytecodeHash: '0x26b252b35232d0e9e81939132133c1305283ab3757c70f0ffed8ae22aeac3c73',
};

export const config: AppConfig = {
  rpcUrl: import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8545',
  contractAddress: import.meta.env.VITE_CONTRACT_ADDRESS ?? undefined,
  chainId: num(import.meta.env.VITE_CHAIN_ID, 31337),
  walletMode: normalizeMode(import.meta.env.VITE_WALLET_MODE),
  devPrivateKey:
    import.meta.env.VITE_DEV_PRIVATE_KEY ??
    '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  registrarAddress: import.meta.env.VITE_REGISTRAR_ADDRESS ?? undefined,
  expectedBytecodeHash: import.meta.env.VITE_EXPECTED_BYTECODE_HASH ?? '0x26b252b35232d0e9e81939132133c1305283ab3757c70f0ffed8ae22aeac3c73',
};

// Load saved runtime overrides (browser only).
try {
  const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
  if (raw) {
    const saved = JSON.parse(raw) as Partial<AppConfig>;
    Object.assign(config, saved);
    config.walletMode = normalizeMode(config.walletMode);
    config.chainId = num(String(config.chainId), config.chainId);
  }
} catch {
  // ignore malformed saved config
}

export const saveConfig = (): void => {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    // ignore (e.g. node/test environment)
  }
};

/** True when this browser holds a saved override that shadows the .env values. */
export const hasSavedConfig = (): boolean => {
  try {
    return Boolean(globalThis.localStorage?.getItem(STORAGE_KEY));
  } catch {
    return false;
  }
};

/**
 * Drop the browser override and fall back to the values compiled from
 * client/.env.local. The caller reloads the page afterwards.
 */
export const resetConfig = (): void => {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};

export const applyPreset = (preset: 'anvil' | 'sepolia'): void => {
  const source = preset === 'anvil' ? ANVIL_PRESET : SEPOLIA_PRESET;
  Object.assign(config, source);
  config.walletMode = normalizeMode(config.walletMode);
  saveConfig();
};

/** Chain id -> human readable network name. */
export const chainName = (chainId: number): string => {
  switch (chainId) {
    case 31337:
      return 'Anvil (local)';
    case 31338:
      return 'Anvil (fork)';
    case 11155111:
      return 'Sepolia (testnet)';
    case 1:
      return 'Ethereum Mainnet';
    default:
      return `Chain ${chainId}`;
  }
};
