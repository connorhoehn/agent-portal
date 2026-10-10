surface: local-compute
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/local-compute
pages: portal/src/pages/local-compute
audited: 2026-10-06 12:10 local, headless Chromium 1680x940 (Playwright), Tilt app :5183 / BFF :3001 dev:mock, ui-components 2.413.0, one cookie per role (POST /api/session/login once per role), mock scenarios touched per fixture and restored to default
screenshot: local-compute.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px, the Local compute nested rail flush at x=200, no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. h1 "Local compute" at top 114; one description line and an empty Machines pane. Not flagged as a list page
keyboard: pass — document-order `.focus()` sweep (headless): 25 of 26 controls accept focus; the refusal is the +N chip. Machines / Runs / Configuration are links
empty-state: pass — "No paired machines / Pair a machine and it appears here; the dialog gives you a code, the command to run on it, and moves on by itself once the machine claims it." with a "Pair a machine" button (dialog not opened)
role-gating: has the "Pair a machine" button; Machines / Runs / Configuration visible
notes: No machine is paired in the fixture, so the machine list, run log and node log views were not observed. Screenshot before the keyboard sweep.
