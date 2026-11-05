import { useState } from 'react';
import type { ConsentEvent } from '../lib/events';
import type { UseRegistry } from '../hooks/useRegistry';

const short = (value: string): string =>
  value.length > 14 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;

/** Table of the registry events (backfilled + live). `limit` renders a preview without filters. */
export const EventList = ({ app, limit }: { app: UseRegistry; limit?: number }) => {
  const { events, refreshEvents } = app;
  const [filter, setFilter] = useState<
  'all' | 'recorded' | 'revoked' | 'registrar' | 'paused' | 'unpaused'
>('all');

  const matching = events.filter((e) => filter === 'all' || e.kind === filter);
  const visible = limit === undefined ? matching : matching.slice(0, limit);

  return (
    <div className="card">
      <div className="card-header fw-bold d-flex justify-content-between align-items-center">
        {limit === undefined ? 'Registry events' : `Recent events (last ${limit})`}{' '}
        <span className="badge bg-info text-dark">{limit === undefined ? events.length : visible.length}</span>
      </div>
      <div className="card-body">

        {limit === undefined && (
        <div className="row g-3 mb-3 align-items-end">
          <div className="col-auto">
            <label htmlFor="filter" className="form-label visually-hidden">Filter</label>
            <select
              id="filter"
              className="form-select form-select-sm"
              value={filter}
              onChange={(e) => setFilter(e.target.value as typeof filter)}
            >
              <option value="all">All events</option>
              <option value="recorded">ConsentRecorded</option>
              <option value="revoked">ConsentRevoked</option>
              <option value="registrar">RegistrarUpdated</option>
              <option value="paused">ContractPaused</option>
              <option value="unpaused">ContractUnpaused</option>
            </select>
          </div>
          <div className="col-auto">
            <button className="btn btn-outline-secondary btn-sm" onClick={() => void refreshEvents()}>
              Refresh
            </button>
          </div>
        </div>
        )}

        {visible.length === 0 ? (
          <p className="text-muted small">No events yet.</p>
        ) : (
          <div className="table-responsive">
            <table className="table table-striped table-sm">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Details</th>
                  <th>By</th>
                  <th>Block</th>
                  <th>Tx</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((e: ConsentEvent) => {
                  const details =
                    e.kind === 'recorded'
                      ? `consent ${short(e.consentId)} · patient ${short(e.patient)}`
                      : e.kind === 'revoked'
                      ? `consent ${short(e.consentId)} · patient ${short(e.patient)}`
                      : e.kind === 'registrar'
                      ? `registrar ${short(e.registrar)} · enabled ${e.enabled}`
                      : 'contract';
                  const by =
                    e.kind === 'recorded'
                      ? short(e.issuer)
                      : e.kind === 'revoked'
                      ? short(e.revokedBy)
                      : e.kind === 'registrar' || e.kind === 'paused' || e.kind === 'unpaused'
                      ? short(e.by)
                      : '-';
                  return (
                  <tr key={e.key}>
                    <td>
                      <span
                        className={`badge ${
                          e.kind === 'recorded'
                            ? 'bg-success'
                            : e.kind === 'revoked'
                            ? 'bg-warning text-dark'
                            : e.kind === 'registrar'
                            ? 'bg-info text-dark'
                            : e.kind === 'paused'
                            ? 'bg-danger'
                            : 'bg-secondary'
                        }`}
                      >
                        {e.kind === 'recorded'
                          ? 'RECORDED'
                          : e.kind === 'revoked'
                          ? 'REVOKED'
                          : e.kind === 'registrar'
                          ? 'REGISTRAR'
                          : e.kind === 'paused'
                          ? 'PAUSED'
                          : 'UNPAUSED'}
                      </span>
                    </td>
                    <td className="text-nowrap"><code className="small">{details}</code></td>
                    <td className="text-nowrap"><code className="small">{by}</code></td>
                    <td>{e.blockNumber}</td>
                    <td className="text-nowrap"><code className="small">{short(e.txHash)}</code></td>
                  </tr>
                )})}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
