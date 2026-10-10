surface: session-config
role: sme
user: u-nora (Nora DaSilva) — GET /api/session/me on this sign-in: sub u-nora, tenant orgiq, role sme
url: /iq/release (redirects to /iq/local-compute/configuration)
pages: portal/src/pages/local-compute/ConfigurationPage.tsx
audited: 2026-10-06 12:10 local, headless Chromium 1680x940 (Playwright), Tilt app :5183 / BFF :3001 dev:mock, ui-components 2.413.0, one cookie per role (POST /api/session/login once per role), mock scenarios touched per fixture and restored to default
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px, Local compute nested rail (Machines / Runs / Configuration) flush at x=200, no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. h1 "Session settings"; an info banner says the preview is example data, then "1 update available" and the contents tabs; first table row (Triage a flaky test) at 511px. Not flagged as a list page
keyboard: pass — document-order `.focus()` sweep (headless): 31 of 33 controls accept focus; the refusals are the +N chip and "Open library skill →", which lives inside the collapsed update row. Enter on the "Show details" control of the update row expands it ("Hide details")
empty-state: pass — session-bundles forced to its empty scenario → "No configuration preview / No session bundle has been published yet, so sessions run with the settings baked into their image." (no outage notice, no console error); scenario restored to default afterwards and the page re-checked
role-gating: read-only for every role: all three see the same example bundle; there is no apply or restart control, and the page says so ("this page cannot apply updates or restart sessions")
notes: The update row used to read "Review changes" and open a panel that said no diff was available; it is now "Show details" and the panel says the bundle records which version it ships, not that version's content. /iq/release redirects here. The pages: line pointed at a portal/src/pages/release directory with no .tsx, so it now names ConfigurationPage.tsx alone. Screenshot before the keyboard sweep.
