import { useState } from 'react';
import { registryContract } from '../lib/consent';
import type { UseRegistry } from '../hooks/useRegistry';

/**
 * Revocation panel. Only the patient (the owner of the record) may revoke a
 * consent - the contract rejects every other caller with NotConsentOwner.
 */
export const RevokePanel = ({ app }: { app: UseRegistry }) => {
  const { wallet, connected, send, events } = app;
  const [consentId, setConsentId] = useState('');

  const busy = app.tx.stage !== 'idle' && app.tx.stage !== 'confirmed' && app.tx.stage !== 'failed';

  const revoke = async () => {
    if (!wallet || !consentId.trim()) return;
    const contract = registryContract(wallet.signer);
    await send(() => contract.revokeConsent(consentId.trim()), 'revokeConsent');
  };

  const ownRecords = events.filter((e) => e.kind === 'recorded');

  return (
    <div className="card">
      <div className="card-header fw-bold"><i className="bi-trash me-2"></i>Revoke a consent</div>
      <div className="card-body">

        {!connected ? (
          <p className="text-muted small">Connect a wallet to revoke a consent.</p>
        ) : (
          <>
            <div className="mb-3">
              <label htmlFor="revoke-id" className="form-label">Consent id</label>
              <input
                id="revoke-id"
                className="form-control"
                value={consentId}
                placeholder="0x..."
                onChange={(e) => setConsentId(e.target.value)}
              />
            </div>

            <div className="mb-3">
              <button className="btn btn-danger" onClick={() => void revoke()} disabled={busy || !consentId.trim() || !app.contractReady}>
                Revoke
              </button>
            </div>

            {ownRecords.length > 0 && (
              <>
                <div className="mb-3">
                  <label className="form-label">Recent consents (click to fill the id)</label>
                  <div className="list-group">
                    {ownRecords.slice(0, 8).map((e) => (
                      <div
                        key={e.key}
                        className="list-group-item list-group-item-action small text-truncate"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setConsentId(e.consentId)}
                      >
                        {e.consentId}
                        <br />
                        <span className="text-muted">patient {e.patient}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};
