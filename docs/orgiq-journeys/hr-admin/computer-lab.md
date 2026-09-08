surface: computer-lab
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /admin/devbox
pages: portal/src/pages/admin
audited: 2026-09-08 03:30 local, Chrome 1552px (innerWidth 1552), middleware dev:mock (re-audit: shares portal/src/pages/admin with the KB tabs, which changed)
screenshot: computer-lab.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Build › Computer Lab"; first-row-top: 170px (the "computers 0" list header of the LAB panel, with "nothing here" at 195px — the fleet genuinely has 0 provisioned computers in this seed, so no row exists); the lab chrome is one status bar (LAB · 0 computers · 0 panes · + · shells 0 of 8 open · ?) with no card stack above the list; no horizontal scroll (1552 = 1552)
keyboard: pass — 31 controls counted, 31 reached by a 34-press Tab sweep (rail → the lab's "+", "?" and "new"/"menu"/"all" list-header actions → "+ new computer" → "▶ focused pane" → the "Broadcast instruction" textarea → wraps); every lab control is a real `<button>`/`<textarea>`
empty-state: pass — "No computers to lab / Computer Lab multiplexes a fleet. Provision at least one computer and it will open in a pane." with an enabled "+ new computer" CTA (not pressed — provisioning a devbox has real cost and side effects per CLAUDE.md); the agents list reads "agents 0 · nothing here" and the pane footer "0 targets"
role-gating: hr-admin holds ManageDevbox — Computer Lab is in the Build rail, the page renders rather than redirecting, and "+ new computer" is present and enabled; the same page is what ⌘I's quick-switch offers to create from (see RAIL.md)
notes: the page is a terminal-style multiplexer, so its monospace chrome reads differently from the rest of the shell but sits inside the same content box and breadcrumb; nothing on it is decoration. Re-audit 2026-09-08: renders from `pages/admin`, where the KB detail's Documents and Ingestion-jobs tabs learned to render a degraded listing instead of "No documents ingested yet." / "No ingestion jobs found." Computer Lab reads neither endpoint and is unchanged. Re-measured: content col left 224px w 1304px, the LAB panel's "computers 0" list header at 162px, no horizontal scroll (scrollWidth 1552 = innerWidth), 37 tabbable controls, no failure notice in the DOM, console errors 0; the empty pane still reads the honest "No computers to lab / Computer Lab multiplexes a fleet. Provision at least one computer and it will open in a pane." with a + new computer action.
