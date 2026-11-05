import { useState } from 'react';
import { ContractFactory } from 'ethers';
import { config, saveConfig, applyPreset, chainName, hasSavedConfig, resetConfig } from '../lib/config';
import artifact from '../lib/contractArtifact.json';
import type { UseRegistry } from '../hooks/useRegistry';

// ABI + bytecode must come from the same compile: the hand-written REGISTRY_ABI
// has no constructor fragment, so ethers reads the admin argument as overrides.
const { abi, bytecode } = artifact as { abi: any[]; bytecode: { object: string } };

export const ConfigPanel = ({ app }: { app: UseRegistry }) => {
  const [rpcUrl, setRpcUrl] = useState(config.rpcUrl);
  const [chainId, setChainId] = useState(String(config.chainId));
  const [contractAddress, setContractAddress] = useState(config.contractAddress);
  const [deploying, setDeploying] = useState(false);
  const [message, setMessage] = useState<string | undefined>();

  const apply = () => {
    config.rpcUrl = rpcUrl;
    config.chainId = Number(chainId) || config.chainId;
    config.contractAddress = contractAddress;
    saveConfig();
    setMessage('Saved');
  };

  const deploy = async () => {
    if (!app.wallet) {
      setMessage('Connect a wallet first');
      return;
    }
    setDeploying(true);
    setMessage(undefined);
    try {
      const factory = new ContractFactory(abi, bytecode.object, app.wallet.signer);
      const contract = await factory.deploy(app.wallet.address);
      await contract.waitForDeployment();
      const address = await contract.getAddress();
      config.contractAddress = address;
      setContractAddress(address);
      saveConfig();
      setMessage(`Deployed at ${address}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setDeploying(false);
    }
  };

  const download = () => {
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `config.${config.chainId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="card">
      <div className="card-header fw-bold"><i className="bi-gear me-2"></i>Configuration</div>
      <div className="card-body">
        <div className="mb-2">
          <button className="btn btn-sm btn-outline-primary me-2" onClick={() => { applyPreset('anvil'); setRpcUrl(config.rpcUrl); setChainId(String(config.chainId)); setContractAddress(config.contractAddress); saveConfig(); }}>
            Anvil preset
          </button>
          <button className="btn btn-sm btn-outline-secondary me-2" onClick={() => { applyPreset('sepolia'); setRpcUrl(config.rpcUrl); setChainId(String(config.chainId)); setContractAddress(config.contractAddress); saveConfig(); }}>
            Sepolia preset
          </button>
        </div>
        <div className="d-flex justify-content-between align-items-center mb-2">
          <span className="small text-muted">
            source: {hasSavedConfig() ? 'saved in this browser' : 'client/.env.local'}
          </span>
          {hasSavedConfig() && (
            <button
              className="btn btn-sm btn-outline-danger"
              onClick={() => {
                resetConfig();
                globalThis.location?.reload();
              }}
            >
              Reset
            </button>
          )}
        </div>
        <div className="mb-2">
          <label className="form-label small">RPC URL</label>
          <input className="form-control form-control-sm" value={rpcUrl} onChange={(e) => setRpcUrl(e.target.value)} />
        </div>
        <div className="mb-2">
          <label className="form-label small">Chain ID ({chainName(Number(chainId) || config.chainId)})</label>
          <input className="form-control form-control-sm" value={chainId} onChange={(e) => setChainId(e.target.value)} />
        </div>
        <div className="mb-2">
          <label className="form-label small">Contract address</label>
          <input className="form-control form-control-sm" value={contractAddress} onChange={(e) => setContractAddress(e.target.value)} />
        </div>
        <div className="d-flex gap-2 flex-wrap">
          <button className="btn btn-sm btn-primary" onClick={apply}>Save</button>
          <button className="btn btn-sm btn-success" onClick={() => void deploy()} disabled={deploying || !app.wallet}>
            {deploying ? 'Deploying…' : 'Deploy contract'}
          </button>
          <button className="btn btn-sm btn-outline-dark" onClick={download}>Export JSON</button>
        </div>
        {message && <div className="alert alert-info mt-2 mb-0 py-1 small">{message}</div>}
      </div>
    </div>
  );
};