surface: codebases
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /admin/projects
pages: portal/src/pages/admin
audited: 2026-09-06 08:08 local, Chrome 1552px, middleware dev:mock
screenshot: codebases.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Build › Codebases"; first-row-top: 282px (the first repository card, connorhoehnslalom/orgiq-observability — the 14 linked repos render as a two-column card grid, no table); above the grid one description line and one action row (+ Link a repository · Discover (disabled: "No GitHub connection yet") · Connections · Add one here); no horizontal scroll (1552 = 1552)
keyboard: pass — 73 controls counted, 73 reached by a 76-press Tab sweep (rail → + Link a repository → Connections → Add one here → per card the repo `<a href="https://github.com/…">`, unlink, Clone into workspace → wraps); Enter on the focused "+ Link a repository" opens an inline form (Credential select "none (public repo)", "Paste a GitHub URL (https:// or git@…) or owner/name" input, Initiative select, Link button, Cancel) with focus on Cancel; Enter on Cancel closes it and returns focus to "+ Link a repository" (nothing submitted)
empty-state: n/a — no search or filter on this registry; each card carries its own honest empty lines ("Not in a workspace yet." with a Clone into workspace action, "Nothing has been run against this yet.")
role-gating: hr-admin-only surface (App.tsx RequireRole hr-admin); the rail entry "Codebases" exists only for this role, and every card exposes unlink + Clone into workspace, both write actions (not pressed — cloning provisions a workspace)
notes: the registry now holds the 14 `p-*` initiative repos (one per initiative, all public), matching the repo links shown on Initiatives; Discover stays disabled until a GitHub connection exists and says so inline rather than failing on click. The first-card measurement was taken with the link form closed; with it open the grid starts at 429px.
