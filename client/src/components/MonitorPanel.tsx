import { useState } from 'react';
import type { UseRegistry } from '../hooks/useRegistry';

/**
 * Monitoring panel: shows the alerts raised by the detection rules and the
 * raw telemetry stream (JSONL) produced by the dApp.
 */
export const MonitorPanel = ({ app }: { app: UseRegistry }) => {
  const { alerts, telemetry } = app;
  const [tab, setTab] = useState<'alerts' | 'telemetry'>('alerts');

  return (
    <div className="card">
      <div className="card-header fw-bold d-flex justify-content-between align-items-center">
        Threat monitoring{' '}
        <span className={`badge ${alerts.length > 0 ? 'bg-danger' : 'bg-success'}`}>
          {alerts.length} alert{alerts.length === 1 ? '' : 's'}
        </span>
      </div>
      <div className="card-body">

        <div className="row g-3 mb-3 align-items-end">
          <div className="col-auto">
            <label htmlFor="tab" className="form-label visually-hidden">View</label>
            <select
              id="tab"
              className="form-select form-select-sm"
              value={tab}
              onChange={(e) => setTab(e.target.value as typeof tab)}
            >
              <option value="alerts">Alerts ({alerts.length})</option>
              <option value="telemetry">Telemetry ({telemetry.length})</option>
            </select>
          </div>
        </div>

      {tab === 'alerts' &&
        (alerts.length === 0 ? (
          <p className="text-muted small">
            No alerts. Rule R1 fires after 3 unauthorized attempts within 60 s; rule R2 fires
            after 5 operational failures within 5 min or a p95 latency above 2000 ms.
          </p>
        ) : (
          <div className="list-group">
            {alerts
              .slice()
              .reverse()
              .map((alert) => (
                <div key={alert.id} className={`list-group-item ${alert.severity === 'high' ? 'list-group-item-danger' : 'list-group-item-warning'}`}>
                  <div className="d-flex justify-content-between align-items-start">
                    <div>
                      <span className={`badge ${alert.severity === 'high' ? 'bg-danger' : 'bg-warning text-dark'}`}>
                        {alert.ruleId} · {alert.severity.toUpperCase()}
                      </span>{' '}
                      <strong>{alert.title}</strong>
                    </div>
                  </div>
                  <div style={{ marginTop: 4 }}>{alert.description}</div>
                  <div className="small text-muted">
                    Reaction: {alert.reaction} · raised at {alert.raisedAt}
                  </div>
                </div>
              ))}
          </div>
        ))}

      {tab === 'telemetry' && (
        <div className="list-group">
          {telemetry
            .slice()
            .reverse()
            .slice(0, 100)
            .map((record) => (
              <div key={record.sequence ?? `${record.ts}-${record.event}-${record.method ?? ''}`} className="list-group-item small text-truncate">
                <span
                  className={`badge ${record.level === 'error' ? 'bg-danger' : record.level === 'warn' ? 'bg-warning text-dark' : 'bg-info text-dark'}`}
                >
                  {record.category}
                </span>{' '}
                {record.event}
                {record.method ? ` · ${record.method}` : ''}
                {record.metrics?.latencyMs !== undefined
                  ? ` · ${record.metrics.latencyMs} ms`
                  : ''}
                {record.message ? ` · ${record.message}` : ''}
              </div>
            ))}
        </div>
      )}
      </div>
    </div>
  );
};
