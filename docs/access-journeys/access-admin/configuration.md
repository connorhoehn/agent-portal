surface: configuration
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/configuration
pages: portal/src/pages/access/ConfigurationPage.tsx,middleware/src/routes/access.ts,portal/src/App.tsx
audited: 2026-10-13 14:52–15:01 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context per script, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001, Vite :5183, ui-components 2.442.2; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}; no 401 during the walk
screenshot: configuration.jpg
verdict: pass
console errors: 0 on the surface (1 network 400 from this walk's deliberate invalid-duration PUT)
layout: no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224, top 111; trail 'System › Configuration'; section headings Durations, Stewards, Catalog items are h2 at 14/600; catalog table rows 8 at 44px, one line each; not a list page, so no composer
keyboard: pass — Tab visited 38 stops (17 inside main) against 17 really-visible focusable controls
empty-state: n/a — the form always has values (durations, stewards, 8 catalog items); a failed read would render UnavailableNotice
role-gating: editable for access-admin (no Read-only chip): Save in the header, disabled while clean; 8 default-duration selects and 8 Sensitive switches. SME in Work 30 days → 7 days: '1 unsaved change' with Discard; Discard restores 30 days and disables Save; changed again and saved at 14:59:47 → toast 'Configuration saved — 1 catalog item updated. Open requests keep their chain.', GET 7d, Save disabled again; restored to 30 days through the same Save (GET 30d); PUT defaultDuration '9y' → 400 'role:orgiq:sme.defaultDuration must be one of 8h, 24h, 7d, 30d, standing'. Durations and Stewards are read-only, 'Fixed by the design'
notes: configuration-saved.jpg is the page right after the save. The Sensitive switch was not toggled.
