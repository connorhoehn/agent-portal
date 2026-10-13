surface: audit
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/audit
pages: portal/src/pages/access/AuditPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 15:03–15:07 local (re-walk on ui-components 2.442.2), Chromium 1456×940 (Playwright headless from portal/, a fresh context per run signed in through portal/e2e/realSession.ts openAs as u-omar — not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared; u-rhea and u-priya walked concurrently; no 401 on my session)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: audit.jpg
verdict: pass
console errors: 0 (load, Filters, composer, row click); the POST probe below is mine
layout: pass — content column left 200 w 1256; trail "Govern › Audit" at left 224 top 68; title 20/600 at top 111; 11 body rows all 44px, one line; composer docked 842–882; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×51, 12/400×8, 12/600×8, 10/600×11, 14/500×1, 20/600×1
keyboard: pass — 18 really-visible focusables in main, Tab visited 19; a row click on a req- event → /access/requests/req-0001; Escape closes the Filters popover
empty-state: pass — "search events for zzzz" → "0 of 11 events"
role-gating: pass — scoped to his read rule: GET /api/access/audit → 11 events over req-0001, req-0002, req-0003, req-0005, req-0006, every one readable (GET each → 200); req-0004 (Nora's, GET → 404) has no events in his list. The scope sentence sits in the header's About popover / description, not as a visible line on the page (no "You see…" text in main). POST /api/access/audit → 404 (append-only). No row checkboxes (0)
notes: Composer: help lists search events / show submitted|approved|rejected|withdrawn|override|blocked events / reset filters / refresh / open and says "The audit trail is append-only; commands change nothing."; "search events for rhea" → 5 of 11; "show submitted events" → "Filter: submitted." and 4 of 11 (search kept); "reset filters" → 11 of 11; "open evt-0001" → /access/requests/req-0001; "approve req-0001" → "Command not recognized … No changes were made." Walked before my own writes (15:04).
