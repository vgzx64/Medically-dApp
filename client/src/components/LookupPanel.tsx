import { useState } from 'react';
import { getConsent, getConsentStatus, isConsentValid, type ConsentRecord } from '../lib/consent';
import { ConsentStatus } from '../lib/abi';
import type { UseRegistry } from '../hooks/useRegistry';

/** Read-only consent lookup panel. */
export const LookupPanel = ({ app }: { app: UseRegistry }) => {
  const { wallet, connected } = app;
  const [consentId, setConsentId] = useState('');
  const [checkIssuer, setCheckIssuer] = useState('');
  const [checkVersion, setCheckVersion] = useState('1');
  const [record, setRecord] = useState<ConsentRecord | undefined>(undefined);
  const [status, setStatus] = useState<ConsentStatus | undefined>(undefined);
  const [isValid, setIsValid] = useState<boolean | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const provider = wallet?.provider;

  const lookup = async () => {
    if (!provider || !consentId.trim()) return;
    setLoading(true);
    setError(undefined);
    setRecord(undefined);
    setStatus(undefined);
    setIsValid(undefined);
    try {
      const [rec, stat] = await Promise.all([
        getConsent(provider as any, consentId.trim()),
        getConsentStatus(provider as any, consentId.trim()),
      ]);
      setRecord(rec);
      setStatus(stat);
      if (rec && checkIssuer.trim()) {
        const valid = await isConsentValid(provider as any, consentId.trim(), checkIssuer.trim(), Number(checkVersion) || 0);
        setIsValid(valid);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  if (!connected) {
    return (
      <div className="card">
        <div className="card-header fw-bold"><i className="bi-search me-2"></i>Consent lookup</div>
        <div className="card-body">
          <p className="text-muted small">Connect a wallet to look up consent records.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header fw-bold"><i className="bi-search me-2"></i>Consent lookup</div>
      <div className="card-body">
        <div className="mb-3">
          <label htmlFor="lookup-cid" className="form-label">Consent id</label>
          <div className="input-group input-group-sm">
            <input id="lookup-cid" className="form-control" value={consentId} onChange={(e) => setConsentId(e.target.value)} placeholder="0x..." />
            <button className="btn btn-primary" onClick={() => void lookup()} disabled={loading || !consentId.trim()}>
              {loading ? 'Loading…' : 'Lookup'}
            </button>
          </div>
        </div>
        {error && <div className="alert alert-danger mb-3">{error}</div>}
        {record && (
          <>
            <div className="row g-3 mb-3">
              <div className="col-md-4"><label className="form-label small text-muted">Status</label>
                <div>{status === ConsentStatus.Active ? <span className="badge bg-success">ACTIVE</span> : status === ConsentStatus.Revoked ? <span className="badge bg-danger">REVOKED</span> : status === ConsentStatus.Expired ? <span className="badge bg-warning text-dark">EXPIRED</span> : <span className="badge bg-secondary">NONE</span>}</div>
              </div>
              <div className="col-md-4"><label className="form-label small text-muted">Patient</label>
                <div className="text-nowrap"><code className="small">{record.patient}</code></div>
              </div>
              <div className="col-md-4"><label className="form-label small text-muted">Issuer</label>
                <div className="text-nowrap"><code className="small">{record.issuer}</code></div>
              </div>
              <div className="col-md-4"><label className="form-label small text-muted">Version</label><div>{record.version}</div></div>
              <div className="col-md-4"><label className="form-label small text-muted">Created at</label>
                <div>{new Date(record.createdAt * 1000).toISOString()}</div>
              </div>
              <div className="col-md-4"><label className="form-label small text-muted">Expires at</label>
                <div>{record.expiresAt === 0 ? 'Never' : new Date(record.expiresAt * 1000).toISOString()}</div>
              </div>
            </div>
            <div className="mb-3">
              <label className="form-label small text-muted">Consent hash</label>
              <div className="text-nowrap text-truncate"><code className="small">{record.consentHash}</code></div>
            </div>
            <div className="mb-3">
              <label className="form-label small text-muted">Validity check for organisation &amp; version</label>
              <div className="row g-2 align-items-end">
                <div className="col-md-5">
                  <input className="form-control form-control-sm" value={checkIssuer} onChange={(e) => setCheckIssuer(e.target.value)} placeholder="organisation address" />
                </div>
                <div className="col-md-4">
                  <input className="form-control form-control-sm" type="number" value={checkVersion} onChange={(e) => setCheckVersion(e.target.value)} min={0} />
                </div>
                <div className="col-md-3">
                  <button className="btn btn-sm btn-outline-primary w-100" onClick={() => { if (!record || !checkIssuer.trim()) return; void isConsentValid(provider as any, consentId.trim(), checkIssuer.trim(), Number(checkVersion) || 0).then((v) => setIsValid(v)); }} disabled={!record || !checkIssuer.trim()}>Check</button>
                </div>
              </div>
              {isValid !== undefined && (
                <div className={`mt-2 alert ${isValid ? 'alert-success' : 'alert-warning'}`}>Consent is {isValid ? 'VALID' : 'NOT VALID'} for this issuer/version.</div>
              )}
            </div>
          </>
        )}
        {!record && !error && !loading && <p className="text-muted small">Enter a consent id to look it up.</p>}
      </div>
    </div>
  );
};
