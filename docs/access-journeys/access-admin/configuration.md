surface: configuration
role: access-admin
user: u-priya (Priya Venkataraman)
url: /access/configuration
pages: portal/src/pages/access/ConfigurationPage.tsx,middleware/src/routes/access.ts,portal/src/App.tsx
audited: 2026-10-13 07:10 local, Chromium 148.0.7778.96 1680x940 (Playwright headless from portal/node_modules, fresh context, signed in by POST /api/session/login, not the shared Chrome tab), middleware dev:mock :3001 reset before and after, Vite :5183, ui-components 2.441.8; GET /api/session/me: sub u-priya, tenant access, role access-admin, grants {"access":["access-admin"]}
screenshot: configuration.jpg
verdict: pass
console errors: 0
layout: pass — no horizontal scroll (scrollWidth 1680 = innerWidth 1680); 1 <main>; trail (nav Breadcrumb) is the first row of the content column at top 68, left 224 = 200px rail + 24px gutter; h1 20/600 at left 224; table body rows 8 at 44px, one line each; no list, so no composer
keyboard: pass — Tab visited 38 stops (17 inside main) against 17 really-visible focusable controls in main (a radio group is one tab stop)
empty-state: n/a — the form always has values (durations, stewards, 8 catalog items); a failed read would render UnavailableNotice
role-gating: editable for access-admin (no Read-only chip): Save in the header, disabled while clean; the catalog table has 8 default-duration selects and 8 Sensitive switches. Changed SME in Work's default 30 days → 7 days: '1 unsaved change' appears with Discard; Discard restores 30 days and disables Save; changed again and Save → PUT /api/access/configuration 200, toast '✓ Configuration saved — 1 catalog item updated. Open requests keep their chain.', GET shows 7d, Save disabled again; restored to 30d the same way; an invalid duration → 400. GET /api/access/configuration 200. Durations and Stewards sections are read-only, marked 'Fixed by the design'.
notes: configuration-saved.jpg shows the page right after the save. The Sensitive switch was not toggled in this walk. Mock reset after the walk.
