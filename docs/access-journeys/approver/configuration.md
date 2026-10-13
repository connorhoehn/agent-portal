surface: configuration
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/configuration
pages: portal/src/App.tsx,portal/src/components/shell/portalCommands.ts,portal/src/pages/access/ConfigurationPage.tsx
audited: 2026-10-13 15:03–15:07 local (re-walk on ui-components 2.442.2), Chromium 1456×940 (Playwright headless from portal/, a fresh context per run signed in through portal/e2e/realSession.ts openAs as u-omar — not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared; u-rhea and u-priya walked concurrently; no 401 on my session)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0 (the redirect target loads clean)
layout: pass — /access/configuration redirects to /access/requests: content column left 200 w 1256, trail at left 224 top 68, title "Requests" 20/600 at top 111, row 44px, composer docked 842–882, no horizontal scroll (1456/1456), 1 <main>
keyboard: pass — on the landing, 9 really-visible focusables, Tab visited 10; Cmd+K opens the palette and Escape closes it (0 options left)
empty-state: pass — /access/configuration/stewards renders the shell's "Page not found — Nothing lives at /access/configuration/stewards."
role-gating: pass — refused three agreeing ways: 0 links to /access/configuration anywhere in the page (rail: Catalog, Requests, Approvals, Policies, Reviews, Audit, Settings); the palette answers "configuration" with only "Open reviews — Campaigns still waiting on decisions"; the route redirects. API: PUT /api/access/configuration {} → 403 ManageAccessPolicy; GET /api/access/configuration → 200 (ViewAccess: durations and steward rules)
notes: The read endpoint answers any ViewAccess role (read-only policy data); only the write is gated. Judged acceptable, not a failure.
