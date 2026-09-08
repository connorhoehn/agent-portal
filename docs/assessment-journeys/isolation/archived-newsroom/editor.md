role: editor
user: u-editor
pages: portal/src/pages/newsroom
audited: 2026-09-05 08:36 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Newsroom (newsroom · 2 roles: Editor, Reporter); no "Assessment" in the body text
assessment-nav-visible: no         # rail on /newsroom/home: Home, Articles, Beat coverage, Researcher, Briefs, Headlines, Pitches, Settings — zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → "/" → /select ("Choose a workspace")
api-status: 403                    # fetch /api/assessment/teams → 403; POST /api/session/tenant {assessment} → 403
screenshot: editor.jpg
verdict: pass
notes: grants in /me are {newsroom:[editor, reporter]}. Editor is the newsroom's publishing role; it has no cross-tenant reach and the server refuses the tenant switch outright.
re-verified 2026-09-05 04:12: all four facts hold — Workspaces tab shows only Newsroom (1 tile, 2 roles: Editor, Reporter; no "Assessment" tile); rail as editor has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/select`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:36: all four facts still hold — Workspaces tab shows only Newsroom (2 roles, no Assessment); as editor, rail has 0 assessment anchors; /assessment/teams redirected away (landed on /select); fetch('/api/assessment/teams') returned 403.
