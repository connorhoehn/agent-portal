role: reporter
user: u-reporter
pages: portal/src/pages/newsroom
audited: 2026-09-05 08:35 local, Chrome 1440px, gateway mode, middleware dev:mock (freshness re-sweep)
assessment-tile-visible: no        # /select Workspaces tab: one tile, Newsroom (newsroom · 1 role: Reporter); no "Assessment" in the body text
assessment-nav-visible: no         # rail on /newsroom/home: Home, Articles, Beat coverage, Researcher, Briefs, Headlines, Pitches, Settings — zero anchors matching /assessment
direct-route-result: redirect      # /assessment/teams → RequireTenant → "/" → /newsroom/home ("Newsroom")
api-status: 403                    # fetch /api/assessment/teams → 403; POST /api/session/tenant {assessment} → 403
screenshot: reporter.jpg
verdict: pass
notes: grants in /me are {newsroom:[reporter]}. The second tenant is as sealed from the third as orgiq is; the newsroom rail is its own product and names nothing from either sibling.
re-verified 2026-09-05 04:10: all four facts hold — Workspaces tab shows only Newsroom (1 tile, 1 role: Reporter; no "Assessment" tile); rail on /newsroom/home has zero `<a href>` containing "assessment"; `/assessment/teams` redirected to `/newsroom/home`; `fetch('/api/assessment/teams')` returned 403.
re-verified 2026-09-05 08:35: all four facts still hold — Workspaces tab shows only Newsroom (1 tile, no Assessment); rail has 0 assessment anchors; /assessment/teams redirected to /newsroom/home; fetch('/api/assessment/teams') returned 403.
