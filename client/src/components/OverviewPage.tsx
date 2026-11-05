import { EventList } from './EventList';
import { TxStatus } from './TxStatus';
import { WalletPanel } from './WalletPanel';
import { toHash } from '../lib/navigation';
import type { UseRegistry } from '../hooks/useRegistry';

/** Landing section: session, last transaction, registry counters and quick actions. */
export const OverviewPage = ({ app }: { app: UseRegistry }) => {
  const { events, alerts, wallet, contractReady } = app;
  const recorded = events.filter((e) => e.kind === 'recorded').length;
  const revoked = events.filter((e) => e.kind === 'revoked').length;

  return (
    <div className="row g-3">
      <div className="col-12 col-lg-6 col-xxl-4">
        <WalletPanel app={app} />
      </div>
      <div className="col-12 col-lg-6 col-xxl-4">
        <TxStatus app={app} />
      </div>

      <div className="col-12 col-lg-6 col-xxl-4">
        <div className="card">
          <div className="card-header fw-bold">
            <i className="bi bi-clipboard-data me-2"></i>Registry at a glance
          </div>
          <div className="card-body">
            <dl className="row mb-3 small">
              <dt className="col-7 text-muted">Consents recorded</dt>
              <dd className="col-5 text-end">{recorded}</dd>
              <dt className="col-7 text-muted">Consents revoked</dt>
              <dd className="col-5 text-end">{revoked}</dd>
              <dt className="col-7 text-muted">Alerts</dt>
              <dd className="col-5 text-end">
                <span className={`badge ${alerts.length ? 'bg-danger' : 'bg-success'}`}>{alerts.length}</span>
              </dd>
            </dl>

            <div className="d-grid gap-2">
              <a className="btn btn-primary btn-sm" href={toHash({ section: 'consents', tab: 'sign' })}>
                <i className="bi bi-pen me-1"></i>Sign a consent
              </a>
              <a className="btn btn-outline-primary btn-sm" href={toHash({ section: 'consents', tab: 'register' })}>
                <i className="bi bi-file-earmark-check me-1"></i>Register a signed consent
              </a>
              <a className="btn btn-outline-secondary btn-sm" href={toHash({ section: 'events', tab: 'sign' })}>
                <i className="bi bi-list-check me-1"></i>All events ({events.length})
              </a>
              <a className="btn btn-outline-secondary btn-sm" href={toHash({ section: 'monitoring', tab: 'sign' })}>
                <i className="bi bi-shield-exclamation me-1"></i>Monitoring
              </a>
            </div>

            {!wallet && (
              <p className="small text-muted mt-3 mb-0">Connect a wallet to enable the write actions.</p>
            )}
            {wallet && !contractReady && (
              <p className="small text-danger mt-3 mb-0">
                Write actions stay disabled until the registry is reachable — see Configuration.
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="col-12">
        <EventList app={app} limit={5} />
      </div>
    </div>
  );
};
