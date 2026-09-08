surface: session-config
role: sme
user: u-nora (Nora DaSilva); re-confirmed via GET /api/session/me on this page (sub u-nora, role sme, tenant orgiq)
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-05 19:25 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; not an L surface (no first-row-top rule; the Bundled skills table's first row sits at 515px anyway, under one stat strip and the Hooks card); no nested rail; no horizontal scroll (1552/1552)
keyboard: pass — 20 tabbable (no tabindex -1), all 20 reached in one sweep and verified by diffing the focus log against the DOM; the page's only control is "Publish to fleet" (skill and setting rows are read-only text, not actions), and Enter/click on it produces the refusal toast below
empty-state: n/a — no search or filter on this page
role-gating: sme holds ManageDevbox (`SessionConfigPage.tsx:108` gates on it), so unlike member Nora gets the "Pending — sb-2026-09-refresh" section with an ENABLED "Publish to fleet" button. Pressing it is refused with an explained toast "✗ Publish refused — no dry run yet — verify this bundle on at least one box before it reaches the fleet" (a server precondition, not a permission error) — the same behaviour hr-admin recorded; nothing on the page is hidden from sme
notes: For an SME about to dispatch, this page answers "what will my devbox session be configured with?" — live v12, one hook (`lab recall`), three bundled skills with one stale, the pending bundle and who prepared it. The refusal toast tells her what to do next (dry-run on a box) but nothing on the page links to a box or to Computer Lab to do it. The stat strip's DRIFT tile ("1 skill stale") duplicates the "stale" chip in the table right below it.
