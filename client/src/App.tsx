import { useEffect, useState } from 'react';
import { AdminPanel } from './components/AdminPanel';
import { ConfigPanel } from './components/ConfigPanel';
import { ConsentsPage } from './components/ConsentsPage';
import { EventList } from './components/EventList';
import { MonitorPanel } from './components/MonitorPanel';
import { OverviewPage } from './components/OverviewPage';
import { useRegistry, stageLabel } from './hooks/useRegistry';
import { chainName, config, resetConfig } from './lib/config';
import { SECTIONS, parseHash, sectionMeta, toHash, type Route } from './lib/navigation';

const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;
const shortHash = (hash: string): string => `${hash.slice(0, 10)}…${hash.slice(-6)}`;

/**
 * Control panel shell: fixed top bar (network, account, alerts), section
 * navigation in the sidebar and one section in the content area.
 * The section lives in the URL hash, so deep links and back/forward work.
 */
export const App = () => {
  const app = useRegistry();
  const {
    wallet,
    connecting,
    connect,
    disconnect,
    alerts,
    events,
    tx,
    networkOk,
    networkMessage,
    contractReady,
    contractProblem,
  } = app;

  const [route, setRoute] = useState<Route>(() => parseHash(globalThis.location?.hash ?? ''));

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash(globalThis.location?.hash ?? ''));
    globalThis.addEventListener('hashchange', onHashChange);
    return () => globalThis.removeEventListener('hashchange', onHashChange);
  }, []);

  const meta = sectionMeta(route.section);
  useEffect(() => {
    document.title = `${meta.label} · Patient Consent Registry`;
  }, [meta.label]);

  const resetAndReload = () => {
    resetConfig();
    globalThis.location?.reload();
  };

  const counts: Partial<Record<string, number>> = { events: events.length, monitoring: alerts.length };

  return (
    <>
      <header className="app-topbar navbar navbar-dark bg-primary px-3">
        <a className="navbar-brand d-flex align-items-center gap-2 m-0" href="#/overview">
          <i className="bi bi-database"></i>
          <span className="d-none d-sm-inline">Patient Consent Registry</span>
        </a>

        <div className="d-flex align-items-center flex-wrap gap-2">
          <span className="badge bg-light text-dark">
            <i className="bi bi-signal me-1"></i>
            {chainName(config.chainId)} · {config.chainId}
          </span>
          <a
            className={`badge ${
              contractReady || !wallet ? 'bg-light text-dark' : 'bg-danger text-white'
            }`}
            href={toHash({ section: 'config', tab: 'sign' })}
            title={contractReady ? 'Registry reachable' : contractProblem}
          >
            <i className="bi bi-link-45deg me-1"></i>
            {config.contractAddress ? shortAddress(config.contractAddress) : 'no contract'}
          </a>
          <a
            className={`badge ${alerts.length ? 'bg-warning text-dark' : 'bg-light text-dark'}`}
            href={toHash({ section: 'monitoring', tab: 'sign' })}
            title="Threat monitoring"
          >
            <i className="bi bi-shield-exclamation me-1"></i>
            {alerts.length} alert{alerts.length === 1 ? '' : 's'}
          </a>

          {wallet ? (
            <>
              <span className="badge bg-light text-dark" title={wallet.address}>
                <i className="bi bi-person-circle me-1"></i>
                {shortAddress(wallet.address)}
              </span>
              <button className="btn btn-sm btn-outline-light" onClick={disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <button
                className="btn btn-sm btn-light"
                onClick={() => void connect('dev')}
                disabled={connecting}
              >
                Use dev wallet (Anvil)
              </button>
              <button
                className="btn btn-sm btn-outline-light"
                onClick={() => void connect('injected')}
                disabled={connecting}
                title="MetaMask or another injected wallet"
              >
                {connecting ? 'Connecting…' : 'Connect MetaMask'}
              </button>
            </>
          )}
        </div>
      </header>

      <div className="app-body">
        <nav className="app-sidebar" aria-label="Sections">
          {SECTIONS.map((section) => {
            const active = section.id === route.section;
            const count = counts[section.id];
            return (
              <a
                key={section.id}
                className={active ? 'is-active' : undefined}
                href={toHash({ section: section.id, tab: route.tab })}
                aria-current={active ? 'page' : undefined}
              >
                <i className={`bi ${section.icon}`}></i>
                <span>{section.label}</span>
                {count !== undefined && count > 0 && (
                  <span className="nav-count badge bg-secondary">{count}</span>
                )}
              </a>
            );
          })}
        </nav>

        <main className="app-main">
          <div className="page-header">
            <h1 className="h4 mb-0">{meta.label}</h1>
            <p className="text-muted small mb-0">{meta.description}</p>
          </div>

          {wallet && !contractReady && (
            <div className="alert alert-danger d-flex flex-wrap align-items-start justify-content-between gap-2">
              <div>
                <strong>Registry unavailable.</strong> {contractProblem}
              </div>
              <div className="d-flex gap-2">
                <a className="btn btn-sm btn-outline-dark" href={toHash({ section: 'config', tab: 'sign' })}>
                  Open configuration
                </a>
                <button className="btn btn-sm btn-dark" onClick={resetAndReload}>
                  Reset configuration
                </button>
              </div>
            </div>
          )}

          {wallet && !networkOk && (
            <div className="alert alert-warning">
              <strong>Wrong network.</strong> {networkMessage}
            </div>
          )}

          <div className={`app-txstrip${tx.stage === 'failed' ? ' is-failed' : ''}`} role="status" aria-live="polite">
            <span
              className={`badge ${
                tx.stage === 'failed'
                  ? 'bg-danger'
                  : tx.stage === 'confirmed'
                  ? 'bg-success'
                  : tx.stage === 'idle'
                  ? 'bg-secondary'
                  : 'bg-primary'
              }`}
            >
              {stageLabel[tx.stage]}
            </span>
            {tx.message && <span className="text-muted">{tx.message}</span>}
            {tx.hash && (
              <code className="small text-muted">
                tx {shortHash(tx.hash)}
                {tx.blockNumber !== undefined && ` · block ${tx.blockNumber}`}
                {tx.gasUsed !== undefined && ` · gas ${tx.gasUsed.toString()}`}
              </code>
            )}
            {tx.error && <span className="text-danger">{tx.error}</span>}
            {!wallet && <span className="text-muted">Not connected — writes are disabled.</span>}
          </div>

          {route.section === 'overview' && <OverviewPage app={app} />}
          {route.section === 'consents' && <ConsentsPage app={app} tab={route.tab} />}
          {route.section === 'events' && <EventList app={app} />}
          {route.section === 'monitoring' && <MonitorPanel app={app} />}
          {route.section === 'admin' && <AdminPanel app={app} />}
          {route.section === 'config' && <ConfigPanel app={app} />}
        </main>
      </div>
    </>
  );
};
