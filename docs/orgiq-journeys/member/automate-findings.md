surface: automate-findings
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/work/findings
pages: portal/src/pages/work
audited: 2026-10-06 12:10 local, headless Chromium 1680x940 (Playwright), Tilt app :5183 / BFF :3001 dev:mock, ui-components 2.413.0, one cookie per role (POST /api/session/login once per role), mock scenarios touched per fixture and restored to default
screenshot: automate-findings.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px, nested Automate rail flush (0px gap), no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. One h1 "Findings" at top 114; a one-line Dead-letter queue card (empty) then the open/promoted/resolved/dismissed chips; first-row-top: 407px (first finding group "Orphan decisions")
keyboard: pass — document-order `.focus()` sweep (headless): 34 of 35 controls accept focus; the refusal is the +N avatar chip. Filter chips and the group rows are real buttons
empty-state: pass — the Dead-letter queue card reads "Nothing dead-lettered. Failed jobs land here with their error and a requeue button."; each of the open / promoted / resolved / dismissed chips shows a populated group list on this fixture, so no zero-row filter exists to observe
role-gating: can read all four finding groups and switch the status chips; no "Run sweeps now" button
notes: Group expand/promote/dismiss actions were not exercised in this pass; only the read path, filter chips and layout were. Screenshot before the keyboard sweep.
