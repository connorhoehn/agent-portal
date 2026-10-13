surface: catalog
role: requester
user: u-rhea (Rhea Castellanos)
url: /access/catalog
pages: portal/src/pages/access/CatalogPage.tsx,portal/src/pages/access/accessCollectionCommands.ts,portal/src/lib/accessRequests.ts
audited: 2026-10-13 07:04–07:10 local, Chromium 1680x940 (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.441.8
session: /api/session/me sub u-rhea, tenant access, role requester, grants {"access":["requester"]}
screenshot: catalog.jpg
verdict: pass
console errors: 0 (before the surface, after Tab, after every composer phrase, the Filters popover and the Request icon)
layout: pass — content col left 200px w 1480px, top 44, bottom 891; trail "Request › Catalog" at left 224 (24px gutter) top 68; title 224/111; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); 1 <main>; 8 body rows each 44px, one line; command composer docked at y 793–882 inside the column
type: title 20/600 (h1); sizes in main (size/weight x text nodes): 14/400x26, 12/400x24, 12/600x10, 10/600x10, 14/500x1, 20/600x1
keyboard: pass — 15 Tab stops in main (About Catalog, search, Filters, About results, Refresh, eight Request icon buttons, Agent mode, command composer) plus the composer Bold button, all visited; Enter on a focused "Request SME in Work" opened /access/requests/new?item=role%3Aorgiq%3Asme; Escape on the Filters popover returns focus to the Filters button (to "Filters (1 active)" after choosing Social); the composer help is inline text, no popover to close
empty-state: pass — searching "zzzqq" leaves "No catalog item matches this search and workspace."; composer `show work catalog items` after a "moderator" search honestly reports the intersection (0 of 8) with "Other filters unchanged"; Workspace select (Every workspace/Work/Assessment/Social/Pipelines): Social = 1 of 8
role-gating: pass — no Approvals/Configuration anchors in the rail (Catalog, Requests, Policies, Reviews, Audit, Settings), no Save, no decision controls; YOU HOLD and POLICY columns show — for all eight items; API: GET /api/access/catalog 200; PUT /api/access/policies/no-such {} 403 (ManageAccessPolicy); GET /api/access/approvals 403 (DecideAccess); POST /requests/req-0001/steps/1/decide {} 403; PUT /api/access/configuration {} 403; POST /api/access/requests {} 400 "itemId is required"; composer `approve req-0001` -> "Command not recognized … No changes were made." and req-0001 unchanged
notes: Composer phrases observed: help (search catalog items for "name", show work/assessment/social/pipelines catalog items, reset filters, refresh, open <exact ID or title>), search catalog items for moderator -> 1 of 8, reset filters -> 8 of 8, open role:orgiq:sme -> wizard at ?item=role%3Aorgiq%3Asme. The row Request icon opens the same URL. Rail footer strip reads "Demo Needs review · 2 agent drafts need your decision" (sample content). The previous walk's title and focus defects no longer reproduce. Every field above was observed in this re-walk, not carried forward.
