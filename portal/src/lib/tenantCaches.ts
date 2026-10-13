// Tenant/user-scoped client cache hygiene.
//
// A workspace switch and a sign-out both HARD-NAVIGATE (window.location.assign
// / .href), which tears down in-memory React and store state but does NOT touch
// web storage. The keys below cache tenant- or user-scoped DATA that would
// otherwise survive at rest on a shared browser across a tenant switch or a
// logout. Tenant-gated routes won't RENDER another tenant's data (the server
// re-mints the cookie and requireTenant blocks the other tenant), but the bytes
// persist in localStorage/sessionStorage — so we remove them on the boundary.
// Wired from auth.tsx (enterContext / login / logout) before the hard nav.
//
// Device/UI PREFERENCES are deliberately PRESERVED — they are neither tenant nor
// user data, and a switch shouldn't reset someone's theme or list-view choice:
//   'orgiq:preferences:v1'  preferences.ts STORAGE_KEY   — theme, weights, palette
//   'projects-view'         RETIRED ProjectsPage.tsx     — grid/list toggle (the card grid is gone)
//   'initiatives.rail-collapsed.shallow' / '.deep' projects/InitiativesExplorer.tsx — the explorer's « fold, per depth band (library useRailFold)
//   'sprints-view'          sprints/SprintsPage.tsx      — cards/table toggle
// (Also intentionally untouched: auth.tsx's 'orgiq.ssoAutoRedirected', which is
//  a transient sign-in-flow marker, not tenant/user data.)
//
// Where a module already exports a clear we call it (contextChoice); the rest
// are removed by literal key, each documented against its owning module. The
// node:test pins these exact keys so a rename in a source module is caught.

import { clearContextChosen } from './contextChoice.ts';
import { clearRealtimeToken } from './realtimeToken.ts';

/** Exact localStorage keys that cache tenant/user-scoped data. */
const LOCAL_KEYS: readonly string[] = [
  'iq-judge-config',          // pages/iq/EvaluationsPage.tsx STORAGE_KEY — judge-config display cache
  // The compute surface's keys, restated rather than imported from
  // ui-components/compute. Importing the barrel drags in ShellTerminal and so
  // @xterm/xterm, which the plain node:test runner cannot load — and a
  // literal list is what the test below pins anyway. Mirrors
  // COMPUTE_STORAGE_KEYS; the test is the thing that catches a drift.
  'ui-components.computeFleet.v1',  // compute lib/storage.ts FLEET_STORAGE_KEY — fleet mirror
  'ui-components.computeDock.v1',   // compute lib/storage.ts DOCK_STORAGE_KEY — open shells + geometry
  'ui-components.computerLab.v1',   // compute lib/storage.ts LAB_LAYOUT_STORAGE_KEY — pane tree
  // Retired portal keys, kept so a browser still holding them from before the
  // migration is scrubbed once.
  'devbox.boxes.v1',          // RETIRED lib/devboxRegistry.ts — pre-migration fleet mirror
  'devbox.sessionId',         // RETIRED lib/devboxRegistry.ts — legacy single-box session
  'orgiq.terminalDock.v1',    // RETIRED lib/terminalDock.ts — pre-migration dock state
  'orgiq:masquerade:history', // pages/SettingsPage.tsx MASQUERADE_HISTORY_KEY — admin masquerade history
  // realtime-modules' useNotifications read marks (its DEFAULT_STORAGE_KEY),
  // read by the header bell (components/shell/ActivityBell.tsx). The ids are
  // one user's inbox; the server keeps the read truth and replays it.
  'rmn:notifications:read',
];

/** localStorage key PREFIXES — one entry per surface, cleared for every match. */
const LOCAL_PREFIXES: readonly string[] = [
  'chat.session.',            // lib/chatSessions.ts STORAGE_PREFIX — per-surface chat session pointers
  'access.',                  // pages/access/* — any access-tenant draft or view cache (docs/access-tenant-goal.md row 12)
];

// Additive: sessionStorage keys that cache USER-scoped data (not tenant data
// specifically, but the same "survives a hard-nav that doesn't touch web
// storage" problem — DEFECTS #5 (assessor) / #8 (lead-assessor) / #7
// (program-lead, admin)). Observed live: signing in as u-operator in a tab
// that had just been u-jonas still showed u-jonas's six confirmed own-save
// timestamps, because DocPane's "was this save mine?" set never keyed on who
// is signed in. Restated by literal key rather than imported — same
// rationale as the compute keys above (DocPane.tsx pulls in the CRDT/
// realtime-modules stack, which this shared, dependency-light module has no
// business dragging in) — with the node:test below pinning it against a
// rename in DocPane.tsx.
const SESSION_KEYS: readonly string[] = [
  'assessment.knowledge.ownSaveTimestamps', // knowledge/DocPane.tsx OWN_SAVE_TS_STORAGE_KEY — this tab's confirmed own-saves
];

/**
 * Remove every tenant/user-scoped client cache while preserving device/UI
 * preferences. Safe to call in private-browsing mode or when a key is absent:
 * each access is wrapped, and a throwing storage stub never propagates.
 */
export function clearTenantScopedCaches(): void {
  for (const key of LOCAL_KEYS) {
    try { localStorage.removeItem(key); } catch { /* private mode / unavailable — ignore */ }
  }
  for (const prefix of LOCAL_PREFIXES) {
    try {
      // Object.keys returns a snapshot, so removing inside the loop is safe.
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith(prefix)) {
          try { localStorage.removeItem(k); } catch { /* ignore this key */ }
        }
      }
    } catch { /* localStorage unreadable — ignore */ }
  }
  // In-memory: the realtime gateway token names the pre-switch identity.
  try { clearRealtimeToken(); } catch { /* ignore */ }
  // sessionStorage: the per-sub "context chosen" marker owns its own clear...
  try { clearContextChosen(); } catch { /* ignore */ }
  // ...plus the flat sessionStorage keys above.
  for (const key of SESSION_KEYS) {
    try { sessionStorage.removeItem(key); } catch { /* private mode / unavailable — ignore */ }
  }
}
