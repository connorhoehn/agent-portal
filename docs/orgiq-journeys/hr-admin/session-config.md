surface: session-config
role: hr-admin
user: u-rachel (Rachel Kowalski) — protocol names u-hr/Priya Desai; verified via GET /api/session/me
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-15 11:20 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after the page went table-first — the Bundled skills table now sits directly under the stat strip with Hooks and Settings below it — and the publish gate copy changed; signed in as u-rachel via /select → Sign in as → Rachel Kowalski → Org → HR Admin; every field re-observed)
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; not an L surface (no first-row-top rule), but the Bundled skills table's first row now sits at 372px (was 515px) directly under the H1, one description line and the 4-tile Live-bundle strip (Live version / Sessions affected / Bundled skills / Drift); the Hooks card and the Settings card follow the table, and the Pending bundle card sits last; no nested rail; no horizontal scroll (scrollWidth 1692 = innerWidth 1692)
keyboard: pass — 31 tabbable controls and all 31 accept focus (`.focus()` walk); "Publish to fleet" is enabled and the helper line under it now carries a real in-app link — "start one in Computer Lab" → /admin/devbox — so the refusal's "dry-run on a box" has somewhere to go (link not pressed; publish not pressed — it mutates shared dev:mock state)
empty-state: n/a — no search/filter control on this page
role-gating: hr-admin sees the live bundle (v12), Hooks, Bundled skills, Settings, and a "Pending — sb-2026-09-refresh" section with an ENABLED "Publish to fleet" button — a real write control member's read-only page doesn't get (member's log: "Publishing this bundle needs Manage devbox"). Clicking Publish to fleet for hr-admin produced a genuine business-rule refusal toast — "Publish refused — no dry run yet — verify this bundle on at least one box before it reaches the fleet" — not a permission error, confirming hr-admin holds the capability and the server enforces its own preconditions with clear, visible feedback.
notes: this is the good version of the pattern that fails on Promotions (hr-admin/DEFECTS #1) and failed for member on Promotions (member's DEFECTS #3) — a gated write action here gives the user an explicit, readable reason when it can't proceed, instead of silence. Re-audit 2026-09-15 11:20: table-first now — first skill row at 372px. The publish helper reads "Needs a passing dry run on a box — start one in Computer Lab — and a named approver", and Computer Lab is a link to /admin/devbox (the refusal toast's instruction finally has a door). Console errors 0.
