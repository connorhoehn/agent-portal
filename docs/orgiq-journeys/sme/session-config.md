surface: session-config
role: sme
user: u-nora (Nora DaSilva); re-confirmed via GET /api/session/me on this page (sub u-nora, role sme, tenant orgiq)
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-15 11:20 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after the page went table-first — the Bundled skills table now sits directly under the stat strip with Hooks and Settings below it — and the publish gate copy changed; signed in as u-nora via /select → Sign in as → Nora DaSilva (single grant, lands in Org · SME); every field re-observed)
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; not an L surface (no first-row-top rule), but the Bundled skills table's first row now sits at 372px (was 515px) directly under the H1, one description line and the 4-tile Live-bundle strip (Live version / Sessions affected / Bundled skills / Drift); the Hooks card and the Settings card follow the table, and the Pending bundle card sits last; no nested rail; no horizontal scroll (scrollWidth 1692 = innerWidth 1692)
keyboard: pass — 22 tabbable controls and all 22 accept focus (`.focus()` walk); "Publish to fleet" is enabled and the helper line under it now carries a real in-app link — "start one in Computer Lab" → /admin/devbox — so the refusal's "dry-run on a box" has somewhere to go (link not pressed; publish not pressed — it mutates shared dev:mock state)
empty-state: n/a — no search or filter on this page
role-gating: sme holds ManageDevbox (`SessionConfigPage.tsx:108` gates on it), so unlike member Nora gets the "Pending — sb-2026-09-refresh" section with an ENABLED "Publish to fleet" button. Pressing it is refused with an explained toast "✗ Publish refused — no dry run yet — verify this bundle on at least one box before it reaches the fleet" (a server precondition, not a permission error) — the same behaviour hr-admin recorded; nothing on the page is hidden from sme
notes: For an SME about to dispatch, this page answers "what will my devbox session be configured with?" — live v12, one hook (`lab recall`), three bundled skills with one stale, the pending bundle and who prepared it. The refusal toast tells her what to do next (dry-run on a box) but nothing on the page links to a box or to Computer Lab to do it. The stat strip's DRIFT tile ("1 skill stale") duplicates the "stale" chip in the table right below it. Re-audit 2026-09-15 11:20: table-first now — first skill row at 372px. The publish helper reads "Needs a passing dry run on a box — start one in Computer Lab — and a named approver", and Computer Lab is a link to /admin/devbox (the refusal toast's instruction finally has a door). Console errors 0.
