/**
 * Navigation model of the control panel.
 *
 * The UI is a set of sections addressed by the URL hash, so deep links and the
 * browser back/forward buttons work without a router dependency:
 *   #/overview, #/consents/sign, #/events, #/monitoring, #/admin, #/config
 */

export const SECTIONS = [
  {
    id: 'overview',
    label: 'Overview',
    icon: 'bi-speedometer2',
    description: 'Session, last transaction and recent registry activity.',
  },
  {
    id: 'consents',
    label: 'Consents',
    icon: 'bi-file-earmark-text',
    description: 'Sign, register, revoke and look up patient consents.',
  },
  {
    id: 'events',
    label: 'Events',
    icon: 'bi-list-check',
    description: 'Every event emitted by the registry, backfilled and live.',
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    icon: 'bi-shield-exclamation',
    description: 'Alerts raised by rules R1/R2 and the raw telemetry stream.',
  },
  {
    id: 'admin',
    label: 'Admin',
    icon: 'bi-shield-lock',
    description: 'Registrar roles and the pause switch (DEFAULT_ADMIN_ROLE only).',
  },
  {
    id: 'config',
    label: 'Configuration',
    icon: 'bi-gear',
    description: 'RPC endpoint, chain id, contract address and deployment.',
  },
] as const;

export type SectionId = (typeof SECTIONS)[number]['id'];

export const CONSENT_TABS = [
  { id: 'sign', label: 'Sign', icon: 'bi-pen' },
  { id: 'register', label: 'Register', icon: 'bi-file-earmark-check' },
  { id: 'revoke', label: 'Revoke', icon: 'bi-trash' },
  { id: 'lookup', label: 'Look up', icon: 'bi-search' },
] as const;

export type ConsentTabId = (typeof CONSENT_TABS)[number]['id'];

export interface Route {
  section: SectionId;
  /** Only meaningful for the consents section. */
  tab: ConsentTabId;
}

const isSection = (value: string): value is SectionId => SECTIONS.some((s) => s.id === value);
const isTab = (value: string): value is ConsentTabId => CONSENT_TABS.some((t) => t.id === value);

/** Default route: first section, first tab. */
export const DEFAULT_ROUTE: Route = { section: SECTIONS[0].id, tab: CONSENT_TABS[0].id };

/** `#/consents/register` -> { section: 'consents', tab: 'register' }; anything unknown -> default. */
export const parseHash = (hash: string): Route => {
  const [head, tail] = hash.replace(/^#\/?/, '').split('/');
  const section = head && isSection(head) ? head : DEFAULT_ROUTE.section;
  const tab = tail && isTab(tail) ? tail : DEFAULT_ROUTE.tab;
  return { section, tab };
};

/** Route -> hash. The tab is part of the URL only for the consents section. */
export const toHash = (route: Route): string =>
  route.section === 'consents' ? `#/consents/${route.tab}` : `#/${route.section}`;

/** Nav entry for a section, with a safe fallback. */
export const sectionMeta = (id: SectionId) => SECTIONS.find((s) => s.id === id) ?? SECTIONS[0];
