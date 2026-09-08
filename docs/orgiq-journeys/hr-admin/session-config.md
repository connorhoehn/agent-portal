surface: session-config
role: hr-admin
user: u-rachel (Rachel Kowalski) — protocol names u-hr/Priya Desai; verified via GET /api/session/me
url: /iq/release
pages: portal/src/pages/release
audited: 2026-09-05 local, Chrome 1552px, middleware dev:mock
screenshot: session-config.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1352px; not an L surface (no first-row-top rule); no horizontal scroll
keyboard: pass — 29 controls; skill/setting rows, and the "Publish to fleet" button are real, reachable elements
empty-state: n/a — no search/filter control on this page
role-gating: hr-admin sees the live bundle (v12), Hooks, Bundled skills, Settings, and a "Pending — sb-2026-09-refresh" section with an ENABLED "Publish to fleet" button — a real write control member's read-only page doesn't get (member's log: "Publishing this bundle needs Manage devbox"). Clicking Publish to fleet for hr-admin produced a genuine business-rule refusal toast — "Publish refused — no dry run yet — verify this bundle on at least one box before it reaches the fleet" — not a permission error, confirming hr-admin holds the capability and the server enforces its own preconditions with clear, visible feedback.
notes: this is the good version of the pattern that fails on Promotions (hr-admin/DEFECTS #1) and failed for member on Promotions (member's DEFECTS #3) — a gated write action here gives the user an explicit, readable reason when it can't proceed, instead of silence.
