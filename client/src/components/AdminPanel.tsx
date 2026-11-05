import { useEffect, useState } from 'react';
import {
  readOnlyContract,
  registryContract,
} from '../lib/consent';
import type { UseRegistry } from '../hooks/useRegistry';

/**
 * Admin panel.
 *
 * Only the ADMIN_ROLE holder can:
 *   - grant / revoke REGISTRAR_ROLE (setRegistrar)
 *   - pause / unpause the contract (pause / unpause)
 */
export const AdminPanel = ({ app }: { app: UseRegistry }) => {
  const { wallet, connected, send, events } = app;

  const [paused, setPaused] = useState<boolean | undefined>(undefined);
  const [isAdmin, setIsAdmin] = useState<boolean | undefined>(undefined);
  const [registrar, setRegistrar] = useState('');
  const [enable, setEnable] = useState(true);

  const busy =
    app.tx.stage !== 'idle' &&
    app.tx.stage !== 'confirmed' &&
    app.tx.stage !== 'failed';

  useEffect(() => {
    if (!wallet) {
      setPaused(undefined);
      setIsAdmin(undefined);
      return;
    }
    let cancelled = false;
    const check = async () => {
      try {
        const contract = readOnlyContract(wallet.provider as any);
        // Read the role first: putting an awaited call inside Promise.all can
        // leave a dangling rejection when the contract has no code.
        const role = (await contract.ADMIN_ROLE()) as string;
        const [adminHas, paus] = await Promise.all([
          contract.hasRole(role, wallet.address),
          contract.paused(),
        ]);
        if (!cancelled) {
          setIsAdmin(adminHas as boolean);
          setPaused(paus as boolean);
        }
      } catch {
        if (!cancelled) {
          setIsAdmin(undefined);
          setPaused(undefined);
        }
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const setRegistrarRole = async () => {
    if (!wallet || !registrar.trim()) return;
    const contract = registryContract(wallet.signer);
    await send(
      () => contract.setRegistrar(registrar.trim(), enable),
      'setRegistrar',
    );
  };

  const doPause = async () => {
    if (!wallet) return;
    const contract = registryContract(wallet.signer);
    await send(() => contract.pause(), 'pause');
  };

  const doUnpause = async () => {
    if (!wallet) return;
    const contract = registryContract(wallet.signer);
    await send(() => contract.unpause(), 'unpause');
  };

  const adminEvents = events.filter(
    (e) =>
      e.kind === 'registrar' || e.kind === 'paused' || e.kind === 'unpaused',
  );

  if (!connected) {
    return (
      <div className="card">
        <div className="card-header fw-bold">Admin</div>
        <div className="card-body">
          <p className="text-muted small">
            Connect a wallet to access admin functions.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header fw-bold d-flex justify-content-between align-items-center">
      <i className="bi bi-shield-check me-2"></i>
        Admin
        <span
          className={`badge ${
            paused ? 'bg-danger' : isAdmin ? 'bg-success' : 'bg-secondary'
          }`}
        >
          {paused ? 'PAUSED' : isAdmin === true ? 'ADMIN' : 'NOT ADMIN'}
        </span>
      </div>
      <div className="card-body">
        {!isAdmin && (
          <p className="text-muted small">
            The connected account does not hold ADMIN_ROLE. Admin actions are
            read-only.
          </p>
        )}
        {paused && (
          <div className="alert alert-warning mb-3">
            The contract is paused. Consent registration and revocation are
            blocked until an admin unpauses it.
          </div>
        )}

        <div className="mb-3">
          <label htmlFor="admin-registrar" className="form-label">
            Registrar address
          </label>
          <input
            id="admin-registrar"
            className="form-control form-control-sm"
            value={registrar}
            onChange={(e) => setRegistrar(e.target.value)}
            placeholder="0x..."
          />
        </div>
        <div className="mb-3 form-check">
          <input
            className="form-check-input"
            type="checkbox"
            id="admin-enable"
            checked={enable}
            onChange={(e) => setEnable(e.target.checked)}
          />
          <label className="form-check-label" htmlFor="admin-enable">
            Grant role (unchecked = revoke)
          </label>
        </div>
        <div className="d-flex gap-2">
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void setRegistrarRole()}
            disabled={busy || !isAdmin || !registrar.trim() || !app.contractReady}
          >
            {busy ? 'Processing…' : 'Set registrar'}
          </button>
          <button
            className="btn btn-sm btn-outline-danger"
            onClick={() => void doPause()}
            disabled={busy || !isAdmin || paused || !app.contractReady}
          >
            <i className="bi bi-pause me-1"></i>
            Pause
          </button>
          <button
            className="btn btn-sm btn-outline-success"
            onClick={() => void doUnpause()}
            disabled={busy || !isAdmin || !paused || !app.contractReady}
          >
            <i className="bi bi-play me-1"></i>
            Unpause
          </button>
        </div>

        {adminEvents.length > 0 && (
          <div className="mt-3">
            <label className="form-label small mb-2 d-block">
              Recent admin events
            </label>
            <div className="list-group list-group-flush small">
              {adminEvents.slice(0, 8).map((e) => (
                <div
                  key={e.key}
                  className="list-group-item list-group-item-action text-truncate"
                >
                  {e.kind === 'registrar'
                    ? `Registrar ${short(e.registrar)} ${e.enabled ? 'granted' : 'revoked'} by ${short(e.by)}`
                    : e.kind === 'paused'
                    ? `Paused by ${short(e.by)}`
                    : `Unpaused by ${short(e.by)}`}
                  <br />
                  <span className="text-muted">{short(e.txHash)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const short = (value: string): string =>
  value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;