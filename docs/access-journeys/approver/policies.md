surface: policies
role: approver
user: u-omar (Omar Haddad, Rhea's manager)
url: /access/policies (list); /access/policies/sod-001 (record page); /access/policies/sod-missing
pages: portal/src/pages/access/PoliciesPage.tsx
audited: 2026-10-13 15:55–15:56 local, Chromium 1456x940 (Playwright headless from portal/node_modules, a fresh context for this identity signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.3
session: /api/session/me sub u-omar, tenant access, role approver, grants {"access":["approver"]}
screenshot: policies.jpg
verdict: fail — the record page's list rail mixes sibling heading sizes: h2 "Policies 4" at 12/600 beside the group headings "Blocking" / "Warning" at h3 14/600, which the type-scale sweep records as `siblings rail 12|14` for /access/policies/:id with no burn-down row. The 18/400 title and 13px body of the last walk are gone: the record is now 20/600 page title, 14/600 record heading, 14/400 values, 12/400 labels
console errors: 0 (list, composer, Enter on a row, record page, rail click, Back, sod-missing); the two 403s are my deliberate PUT probes
layout: pass — list: content column left 200 w 1256; trail "Govern › Policies"; title 20/600 at 224/111; 4 body rows 44px one line; composer docked at y 842–882; no horizontal scroll (1456/1456); sizes 14/400x22, 12/600x8, 12/400x2, 10/600x4, 14/500x1, 20/600x1. Record page /access/policies/sod-001 (policies.jpg): primary rail folds to the 44px strip, the list rail 44–308 beside the content; trail "Govern › Policies › Spend and allocate"; h1 "Policies" 20/600 at 332/88 (24px from the rail edge); record heading "Spend and allocate" h3 14/600 at 332/134; composer docked at y 842–882; no horizontal scroll
keyboard: pass — list: Enter on the focused first row → the record page /access/policies/sod-001 (no drawer, so Escape has nothing to close and leaves the URL alone); record Tab stops: Find a policy, the selected rail row, the Policies crumb, Agent, the composer; a rail click opened sod-004 and Back returned to sod-001
empty-state: pass — "search policies for zzzqq" → "No policy matches this search and severity." (0 of 4); /access/policies/sod-missing renders "Policy not found — No separation-of-duties policy has the id "sod-missing"."
role-gating: pass — read-only for the approver: 0 Edit/Save on the list; the record page holds 0 Save buttons, 0 radios, 0 textareas (buttons: the rail rows, Agent, Apply disabled); no row checkboxes. PUT /api/access/policies/sod-001 {} → 403 ManageAccessPolicy; {severity:"warning"} → 403
notes: Composer: help lists the supported phrases; "search policies for sme" → 2 of 4; "show blocking policies" → 1 of 4 with the notice "Filter: block."; "reset filters" → 4 of 4; "approve req-0001" → "Command not recognized … No changes were made." Off the 12/14/20 steps on the record page are only the rail's count badge (11/600) and the severity chip (10/600).
