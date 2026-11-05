import { config } from './src/lib/config';

// Tests need a configured contract address; without it the registry-bound
// helpers in consent.ts throw. These match a fresh Anvil deployment.
config.contractAddress = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
config.registrarAddress = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
