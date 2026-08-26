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
//   'projects-view'         ProjectsPage.tsx             — grid/list toggle
// (Also intentionally untouched: auth.tsx's 'orgiq.ssoAutoRedirected', which is
//  a transient sign-in-flow marker, not tenant/user data.)
//
// Where a module already exports a clear we call it (contextChoice); the rest
// are removed by literal key, each documented against its owning module. The
// node:test pins these exact keys so a rename in a source module is caught.

import { clearContextChosen } from './contextChoice.ts';

/** Exact localStorage keys that cache tenant/user-scoped data. */
const LOCAL_KEYS: readonly string[] = [
  'iq-judge-config',          // pages/iq/EvaluationsPage.tsx STORAGE_KEY — judge-config display cache
  'devbox.boxes.v1',          // lib/devboxRegistry.ts KEY — devbox fleet mirror
  'devbox.sessionId',         // lib/devboxRegistry.ts LEGACY_SESSION_KEY — legacy single-box session
  'orgiq.terminalDock.v1',    // lib/terminalDock.ts STORAGE_KEY — open shells / dock geometry
  'orgiq:masquerade:history', // pages/SettingsPage.tsx MASQUERADE_HISTORY_KEY — admin masquerade history
];

/** localStorage key PREFIXES — one entry per surface, cleared for every match. */
const LOCAL_PREFIXES: readonly string[] = [
  'chat.session.',            // lib/chatSessions.ts STORAGE_PREFIX — per-surface chat session pointers
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
  // sessionStorage: the per-sub "context chosen" marker owns its own clear.
  try { clearContextChosen(); } catch { /* ignore */ }
}
