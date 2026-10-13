surface: configuration
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/configuration
pages: portal/src/pages/access/ConfigurationPage.tsx,portal/src/App.tsx,portal/src/components/shell/Layout.tsx
audited: 2026-10-13 06:36 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before the walk, Vite :5183; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 14/600 (the compact header density; /pipelines/runs and /pipelines/configuration measure the same 14/600 in this walk, so the protocol's 20/600 is stale, not an access defect); no table and no composer on this form page
keyboard: pass — 1 stop(s) in main: the header info button; the only form controls (Default duration select, Save) are disabled and so correctly skipped by Tab
empty-state: n/a — the form always has values (durations, stewards, 8 catalog items); a failed catalog read would render UnavailableNotice
role-gating: read-only form: Read-only chip and the notice 'Read-only in lane A0. Editing arrives with the catalog writes; nothing on this page is saved.'; Default duration select is disabled; Save is present and disabled, and its tooltip reads the same reason (hover verified). access-admin reaches the route (rail lists /access/configuration). Sections: Durations, Stewards (hr-admin, program-lead, community-admin, pipeline-admin; initiative owner; sensitive items need an access admin), Catalog items (8 requestable).
notes: The page and its tooltip still say 'lane A0' although A1 (provisioning, expiry, live request thread) has landed — stale copy, noted in DEFECTS.md.
