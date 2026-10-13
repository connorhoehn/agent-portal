surface: policies
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/policies
pages: portal/src/pages/access/PoliciesPage.tsx,portal/src/lib/accessRequests.ts
audited: 2026-10-13 06:20–06:33 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: policies.jpg
verdict: fail — page title renders 14/600 instead of the documented 20/600 (D1, platform-wide); the read-only requester behaviour passed
console errors: 0 (before, after Tab, after every composer phrase, the drawer and the Severity filter)
layout: fail on title only — content col left 200 w 1480, top 44, bottom 891; trail "Govern › Policies" at 224/68; title at 224/115; no horizontal scroll (1680/1680); 1 <main>; 4 body rows each 44px one line; composer docked at the bottom
type: title 14/600 (h1), not the documented 20/600 — platform-wide today, /pipelines/runs as u-ines also measures 14px/600 (see DEFECTS.md D1); sizes in main: 14/400x22, 12/600x8, 10/600x4, 12/400x2, 14/500x1, 14/600x1
keyboard: pass — 11 Tab stops in main (About, search, Filters, About results, Refresh, 4 rows, Agent mode, composer) plus composer controls, 15 visited; Enter on the first row opened the drawer "Spend and allocate sod-001" (Holding sme · Work, Must not hold org-leader · Work, severity blocking, why); Escape closed it and focus returned to the row
empty-state: pass — searching "zzzqq" leaves "No policy matches this search and severity."; Severity select (Every severity/Blocking/Warning): Blocking = 2 of 4; composer `show block policies` / `show warn policies` are not supported phrases and answer "Command not recognized"
role-gating: pass — the drawer holds only a Close button and 0 inputs (no severity/reason editing), no Save anywhere on the page (absent from the DOM); API: GET /api/access/policies 200; PUT /api/access/policies/sod-1 {} 403 and {severity:"nuclear"} 403 (ManageAccessPolicy) — the gate answers before body validation; composer `approve req-0001` -> "Command not recognized … No changes were made."
notes: Four policies: Spend and allocate (sme/org-leader, blocking), Write and approve a pipeline (author/operator, blocking), Score and except (assessor/lead-assessor, warning), Moderate and run pipelines (moderator/operator, warning). Composer: help, search policies for sme, reset filters, open Spend and allocate -> "Opened Spend and allocate. Nothing was changed." all worked. Every field above was observed in this pass, not carried forward.
