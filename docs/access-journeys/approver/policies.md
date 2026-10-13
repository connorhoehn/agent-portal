surface: policies
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/policies
pages: portal/src/pages/access/PoliciesPage.tsx
audited: 2026-10-13 06:20–06:45 local, Chromium 1456×940 (Playwright headless from portal/node_modules, fresh context signed in by POST /api/session/login as u-omar, not the shared Chrome tab), Vite :5183 + middleware dev:mock :3001 (shared with other lanes: audit event counts drifted 15→20 mid-walk from another walker's writes)
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: policies.jpg
verdict: pass
console errors: 0 on load and through filters, drawer and composer; the 4 console “403” lines come only from my deliberate PUT probes
layout: pass — content col left 200 w 1256, trail left 224 top 68, title 14/600 (compact PageHeader, identical to /pipelines/approvals measured the same session; the protocol's 20/600 is not what any tenant renders now) at top 115; 4 body rows all 44px one line; composer docked 841–883; no horizontal scroll (1456/1456); 1 <main>; sizes 14/400×22, 12/600×8, 12/400×2, 10/600×4, 14/600×1
keyboard: pass — 11 really-visible focusables in main, Tab visited 12 in main; Enter on a focused row opened the drawer (role dialog, button Close, no inputs); Escape closed it and focus returned to the row; a row click also opens it; Escape closes the Severity filter popover
empty-state: pass — “search policies for zzzz” → “0 of 4 policies”; the Severity filter Blocking → 2 (sod-001, sod-002), Warning → 2 (sod-003, sod-004)
role-gating: pass — read-only: no Save/Update button anywhere (0 buttons with “save” in the DOM) and the drawer holds only Close. Drawer for Spend and allocate: sod-001, Holding sme · Work, Must not hold org-leader · Work, Updated Aug 14 2026, Severity blocking, Why “An SME spends a sprint envelope…”. Writes as approver: PUT /api/access/policies/sod-001 {} → 403 ManageAccessPolicy; {severity:'nope'} → 403; {severity:'warn'} → 403; /no-such → 403 (Cedar refuses before validation); severities unchanged afterwards (block, block, warn, warn)
notes: Composer: help lists search/show blocking|warning policies/reset filters/refresh/open <exact ID or title>; “search policies for pipeline” → 2 of 4; “show blocking policies” → notice “Filter: block.”; “open sod-001” → “Opened Spend and allocate. Nothing was changed.” and the drawer opened; “open spend-and-allocate” → “No matching record in the current table” (not the exact title or id); “approve req-0001” refused with no change. Mock reset after the write probes.
