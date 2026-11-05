import { RegisterPanel } from './RegisterPanel';
import { LookupPanel } from './LookupPanel';
import { RevokePanel } from './RevokePanel';
import { SignPanel } from './SignPanel';
import { CONSENT_TABS, toHash, type ConsentTabId } from '../lib/navigation';
import type { UseRegistry } from '../hooks/useRegistry';

/** Consents section: one operation at a time, addressed by the URL hash. */
export const ConsentsPage = ({ app, tab }: { app: UseRegistry; tab: ConsentTabId }) => (
  <>
    <ul className="nav nav-tabs mb-3">
      {CONSENT_TABS.map((item) => (
        <li className="nav-item" key={item.id}>
          <a
            className={`nav-link${item.id === tab ? ' active' : ''}`}
            href={toHash({ section: 'consents', tab: item.id })}
            aria-current={item.id === tab ? 'page' : undefined}
          >
            <i className={`bi ${item.icon} me-1`}></i>
            {item.label}
          </a>
        </li>
      ))}
    </ul>

    {tab === 'sign' && <SignPanel app={app} />}
    {tab === 'register' && <RegisterPanel app={app} />}
    {tab === 'revoke' && <RevokePanel app={app} />}
    {tab === 'lookup' && <LookupPanel app={app} />}
  </>
);
