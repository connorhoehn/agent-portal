surface: local-compute
role: program-owner
user: u-mia (Mia Singh) — GET /api/session/me on this sign-in: sub u-mia, tenant orgiq, role program-owner
url: /iq/local-compute
pages: portal/src/pages/local-compute
audited: 2026-10-06 12:10 local, headless Chromium 1680x940 (Playwright), Tilt app :5183 / BFF :3001 dev:mock, ui-components 2.413.0, one cookie per role (POST /api/session/login once per role; role set with POST /api/session/role), mock scenarios touched per fixture and restored to default
screenshot: local-compute.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px, the Local compute nested rail flush at x=200, no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. h1 "Local compute" at top 114; one description line and an empty Machines pane. Not flagged as a list page
keyboard: pass — document-order `.focus()` sweep (headless): 28 of 29 controls accept focus; the refusal is the +N chip. Machines / Runs / Configuration are links
empty-state: pass — "No paired machines / Pairing a machine needs machine-pairing access; ask a platform operator to pair one for you." (the copy names the missing capability instead of offering a dead button)
role-gating: no "Pair a machine" button — replaced by copy saying pairing needs machine-pairing access; Machines / Runs / Configuration visible
notes: No machine is paired in the fixture, so the machine list, run log and node log views were not observed. Screenshot before the keyboard sweep.
