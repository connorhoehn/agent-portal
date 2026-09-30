// Run with:  cd portal && node --test 'src/lib/__tests__/*.test.ts'
//
// Plain node:test — the portal has no test runner in package.json, so this
// matches chatSessions.test.ts / repoLink.test.ts. Node strips the types.
//
// clearTenantScopedCaches() is the client half of the tenant-switch/logout
// auth-invalidation fix: a hard reload does NOT clear web storage, so
// tenant/user-scoped DATA would otherwise persist at rest on a shared browser.
// The properties under test:
//
//   1. Every documented DATA key is removed (exact keys + the chat.session.
//      prefix across surfaces), so nothing tenant/user-scoped is left behind.
//   2. Device/UI PREFERENCE keys are PRESERVED — a switch must not reset the
//      theme or the projects list-view choice.
//   3. It never throws, even when storage itself throws (private mode).

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { clearTenantScopedCaches } from '../tenantCaches.ts';

// Minimal Storage stub. Methods live on the prototype (non-enumerable), and
// items are stored as OWN properties — so Object.keys(store) returns exactly
// the stored keys, matching how real localStorage behaves under the prefix scan.
class MemoryStorage {
  getItem(k: string): string | null {
    const own = this as unknown as Record<string, string>;
    return Object.prototype.hasOwnProperty.call(this, k) ? own[k] : null;
  }
  setItem(k: string, v: string): void {
    (this as unknown as Record<string, string>)[k] = String(v);
  }
  removeItem(k: string): void {
    delete (this as unknown as Record<string, string>)[k];
  }
}

function installStorage(): MemoryStorage {
  const store = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = store;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = new MemoryStorage();
  return store;
}

const DATA_KEYS = [
  'iq-judge-config',
  // Retired portal keys — still cleared so a browser holding them from before
  // the ui-components/compute migration is scrubbed once.
  'devbox.boxes.v1',
  'devbox.sessionId',
  'orgiq.terminalDock.v1',
  // The library's keys, which replaced them. Listed literally on purpose: the
  // point of this test is that a rename in ui-components is caught here rather
  // than silently leaving one tenant's terminals on a shared browser.
  'ui-components.computeFleet.v1',
  'ui-components.computeDock.v1',
  'ui-components.computerLab.v1',
  'orgiq:masquerade:history',
  // realtime-modules' useNotifications read marks — one user's inbox ids.
  'rmn:notifications:read',
  'chat.session.invoke',
  'chat.session.explore',
];

const PREF_KEYS = ['orgiq:preferences:v1', 'projects-view'];

beforeEach(() => { installStorage(); });

test('removes every tenant/user-scoped data key (exact + chat.session.* prefix)', () => {
  const store = installStorage();
  for (const k of [...DATA_KEYS, ...PREF_KEYS]) store.setItem(k, 'x');

  clearTenantScopedCaches();

  for (const k of DATA_KEYS) {
    assert.equal(store.getItem(k), null, `expected data key "${k}" to be cleared`);
  }
});

test('preserves device/UI preference keys', () => {
  const store = installStorage();
  for (const k of [...DATA_KEYS, ...PREF_KEYS]) store.setItem(k, 'keep');

  clearTenantScopedCaches();

  for (const k of PREF_KEYS) {
    assert.equal(store.getItem(k), 'keep', `expected preference key "${k}" to be preserved`);
  }
});

test('clears the sessionStorage context-chosen marker', () => {
  installStorage();
  (globalThis as { sessionStorage: MemoryStorage }).sessionStorage.setItem('orgiq.contextChosen', 'u-1');

  clearTenantScopedCaches();

  assert.equal(
    (globalThis as { sessionStorage: MemoryStorage }).sessionStorage.getItem('orgiq.contextChosen'),
    null,
  );
});

// DEFECTS #5 (assessor) / #8 (lead-assessor) / #7 (program-lead, admin):
// u-jonas's six confirmed own-save timestamps were still present in a tab
// after signing in as u-operator, because this sessionStorage key was never
// cleared on a user switch. Additive coverage alongside the pre-existing
// context-chosen-marker test above.
test('clears the assessment knowledge own-save-timestamps sessionStorage key (a user switch must not inherit the previous user\'s own-save set)', () => {
  installStorage();
  const session = (globalThis as { sessionStorage: MemoryStorage }).sessionStorage;
  session.setItem('assessment.knowledge.ownSaveTimestamps', JSON.stringify(['2026-09-06T12:00:00.000Z']));

  clearTenantScopedCaches();

  assert.equal(session.getItem('assessment.knowledge.ownSaveTimestamps'), null);
});

test('does not throw when a key is simply absent', () => {
  installStorage(); // empty storage
  assert.doesNotThrow(() => clearTenantScopedCaches());
});

test('survives a throwing storage stub (private mode)', () => {
  const throwing = {
    removeItem() { throw new Error('SecurityError'); },
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('SecurityError'); },
  };
  // Object.keys(throwing) yields the method names, but removeItem throws and is
  // caught per key; the whole call must still complete cleanly.
  (globalThis as { localStorage?: unknown }).localStorage = throwing;
  (globalThis as { sessionStorage?: unknown }).sessionStorage = throwing;

  assert.doesNotThrow(() => clearTenantScopedCaches());
});
