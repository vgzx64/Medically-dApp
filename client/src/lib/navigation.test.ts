import { describe, expect, it } from 'vitest';
import { CONSENT_TABS, DEFAULT_ROUTE, SECTIONS, parseHash, sectionMeta, toHash } from './navigation';

describe('parseHash', () => {
  it('falls back to the default route for an empty hash', () => {
    expect(parseHash('')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#')).toEqual(DEFAULT_ROUTE);
    expect(parseHash('#/')).toEqual(DEFAULT_ROUTE);
  });

  it('reads a known section', () => {
    expect(parseHash('#/events').section).toBe('events');
    expect(parseHash('#/config').section).toBe('config');
  });

  it('falls back to the default route for an unknown section', () => {
    expect(parseHash('#/nope').section).toBe(DEFAULT_ROUTE.section);
    expect(parseHash('#/consents/nope').tab).toBe(DEFAULT_ROUTE.tab);
  });

  it('reads the consents tab', () => {
    expect(parseHash('#/consents/register')).toEqual({ section: 'consents', tab: 'register' });
    expect(parseHash('#/consents')).toEqual({ section: 'consents', tab: CONSENT_TABS[0].id });
  });
});

describe('toHash', () => {
  it('keeps the tab in the URL only for the consents section', () => {
    expect(toHash({ section: 'consents', tab: 'revoke' })).toBe('#/consents/revoke');
    expect(toHash({ section: 'events', tab: 'sign' })).toBe('#/events');
  });

  it('round-trips every section', () => {
    for (const section of SECTIONS) {
      const route = { section: section.id, tab: CONSENT_TABS[0].id };
      expect(parseHash(toHash(route))).toEqual(route);
    }
  });
});

describe('sectionMeta', () => {
  it('returns the label used by the sidebar and the page header', () => {
    expect(sectionMeta('monitoring').label).toBe('Monitoring');
  });
});
