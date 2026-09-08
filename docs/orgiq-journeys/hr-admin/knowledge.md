surface: knowledge
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /admin/knowledge
pages: portal/src/pages/knowledge
audited: 2026-09-06 08:05 local, Chrome 1552px, middleware dev:mock
screenshot: knowledge.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Operate › Knowledge"; nested "Knowledge" rail (Overview/Registry · Pipeline: Sources/Runs/Storage/KB sync/Schedule) flush with the content box at 224px; first-row-top: 362px (3 rows); above the table one "✕ 1 KB broken" health chip (top-right), one description line and one filter row (search · All | Needs attention · "3 of 3 knowledge bases · registry vs. the live account"); the stat strip (Knowledge bases 2 / Documents indexed 0 / Needs attention 1) sits below the table; no horizontal scroll (1552 = 1552)
keyboard: pass — 53 controls counted, 53 reached by a 56-press Tab sweep (rail → "✕ 1 KB broken" chip button → nested rail → search → All / Needs attention pills → the 3 knowledge-base name links (`<a href="/admin/knowledge/registry/<uuid>">`) → the inline sweeps / manage → / history → / browse → / registry → / Ask / stale-document sweep links → the "Drag documents here" drop zone → "+ New link" → wraps)
empty-state: pass — "Needs attention" toggles aria-pressed and drops the table to the one broken row (OrgIQ Legacy Docs); typing "zzznoexistkb" on top of it renders "No knowledge bases match the current filters" in the table body (header stays, no clear button — the search box's own ✕ clears it)
role-gating: org-leader/hr-admin only; hr-admin sees the reconciliation view with a per-row remediation ("Repoint this from the matching unregistered knowledge base's row, once one appears."), the document drop zone and "+ New link" — write actions a member never reaches
notes: the "points at nothing / Registry points at KBMOCK-GONE, which does not exist in this account" row is the documented KB-registry-drift gotcha surfacing as designed; the "1 KB broken" chip, the Needs-attention count (1) and the filtered row agree. First Tab sweep on this page recorded nothing because the tab had lost input focus (visibilityState hidden) — re-navigating and re-shooting restored it; the numbers above are from the second, complete sweep.
