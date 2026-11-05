/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_RPC_URL?: string;
  readonly VITE_CONTRACT_ADDRESS?: string;
  readonly VITE_CHAIN_ID?: string;
  readonly VITE_WALLET_MODE?: 'injected' | 'dev';
  readonly VITE_DEV_PRIVATE_KEY?: string;
  readonly VITE_REGISTRAR_ADDRESS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
