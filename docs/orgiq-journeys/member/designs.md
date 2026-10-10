surface: designs
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/designs
pages: portal/src/pages/designs
audited: 2026-10-06 12:10 local, headless Chromium 1680x940 (Playwright), Tilt app :5183 / BFF :3001 dev:mock, ui-components 2.413.0, one cookie per role (POST /api/session/login once per role), mock scenarios touched per fixture and restored to default
screenshot: designs.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; the Designs status rail (STATUS 5) flush at x=200, the list rail at x=420; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. h1 "Designs" at top 114 with a one-line description; first-row-top: 247px (Session token rotation on tenant switch); 3 designs
keyboard: pass — document-order `.focus()` sweep (headless): 33 of 34 controls accept focus; the refusal is the +N chip. Enter on the focused first row opens /iq/designs/des-auth-rotation
empty-state: pass — this page has no search box, so the zero-result path is the bad id: /iq/designs/nope-not-real → "Design not found / No design review has the id "nope-not-real"." with "← All designs" (the 404 on /api/designs/nope-not-real is the lookup, the page reads it as not found, not as an outage). The design-reviews fixture's empty and error scenarios did not change the page in this stack, so those states were not observed
role-gating: can list and open designs; no Answer / Approve / Reject in a design's detail
notes: Compared against the earlier pass: the bad-id page used to be an outage notice with Try again, now it is a real not-found state. Screenshot before the keyboard sweep.
