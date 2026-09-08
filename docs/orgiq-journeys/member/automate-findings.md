surface: automate-findings
role: member
user: u-theo (Theo Chang) — GET /api/session/me on this sign-in: sub u-theo, tenant orgiq, role member
url: /iq/work/findings
pages: portal/src/pages/work
audited: 2026-09-06 10:38 local, Chrome 1552×789, middleware dev:mock
screenshot: automate-findings.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Build › Automate › Findings"; nested Automate rail flush with the content box (aside right edge 444px, inner content at 468px w 1060px); first-row-top: 406px (the first findings group row, "critical · Bus factor · 2 findings"; the dead-letter panel above it starts at 230px); above the list one H1, one "Dead-letter queue" heading + its one-line caption + the empty DLQ panel, and one Findings status-pill row; no horizontal scroll (scrollWidth 1552 = innerWidth)
keyboard: pass — 30 tabbable controls, none with tabIndex −1, every one reached in a 34-press Tab sweep (focus-log diff: missing none); the open/promoted/resolved/dismissed pills are `<button aria-pressed>`; each group row is one `<button>` — focusing "Bus factor" and pressing Return expanded it to its two findings ("Aurora cold-start recovery has a single holder", "Flaky-test triage is held by two people on the same team") and flipped its trailing label from "show" to "hide"; the expander still carries no `aria-expanded` (attribute null before and after), so a screen reader hears the label change but not the state
empty-state: pass — the DLQ reads "Nothing dead-lettered. Failed jobs land here with their error and a requeue button."; every findings status has a seeded group (open: Bus factor 2 / Orphan decisions 1 / Stale docs 1; dismissed: "warning · Lab signals · 1 finding"), so the list's own empty panel could not be driven — the pressed pill and the rendered groups agreed on every click
role-gating: member can read the DLQ, switch findings status and expand groups; inside an expanded group there is no promote / dismiss / resolve / analyse / "Run sweeps now" / requeue control (button labels grepped after expanding: only the status pills matched), and no copy tells this role to run something it cannot see
notes: unchanged from the 2026-09-05 pass in substance; the dismissed group is now labelled "Lab signals" (org-leader #7's `sweepLabel()`), not a raw id. Soft: the DLQ empty copy still promises "a requeue button" a member would never get (requeue is ManageDevbox-gated) — harmless while nothing is dead-lettered.
