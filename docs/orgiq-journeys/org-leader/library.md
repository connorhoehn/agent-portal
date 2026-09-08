surface: library
role: org-leader
user: u-vera (Vera Green); re-checked GET /api/session/me on arrival (sub u-vera, tenant orgiq, role org-leader)
url: /iq/library
pages: portal/src/pages/library
audited: 2026-09-05 23:26 local, Chrome 152 at 1552px, middleware dev:mock
screenshot: library.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1352px; nested "Prompt Management" rail (Browse: Library · Ops: What is deployed · Author: Studio / Versions / Evals · Ship: Rollout) flush with the content box (200 = 200); first-row-top: 262px; above the table one description (wraps to two lines at this width, 40px) and one Kind / Tier facet + search row; no horizontal scroll (1552 = 1552)
keyboard: pass — 55 tabbable, all 55 reached in one 70-Tab sweep (focus-log diff: missing none): the rail, the four sub-rail groups and their six entries, the six Kind pills, three Tier pills, the search box and the ten asset-name buttons; Enter on "CSRF risk evaluator" opens the asset drawer (Evaluator · Endpoint · v5 · deployed · Nora Chang; CONTRACT with its fenced `diff` and `framework` inputs, Guardrail gr-security-1, DISTILLED FROM with "Open lineage →", RELEASE READINESS) with focus on Close; Escape closes it and returns focus to the same "CSRF risk evaluator" row button; the Kind pills are real filters (Skill → 3 rows, all Kind = Skill, URL ?kind=skill)
empty-state: pass — searching "zzznoexistasset" renders "Nothing matches / No asset matches these facets. Clear a filter or widen the search." with a Clear filters button; Enter on it (reached by keyboard) empties the search and restores the 10 rows
role-gating: org-leader sees the full Prompt Management rail including Studio / Versions / Evals / Rollout (platform role — ManageCanary true), the entries filtered out for member / sme / program-owner; nothing is hidden for this role
notes: The page answers "what is the fleet instructed by" and the drawer's release-readiness read is what a release manager wants before Rollout. Two things a person notices, both unchanged: the description paragraph is two lines (40px), one over the one-line budget; clicking the ASSET column header sorts the table (↓) — a mouse-only affordance with no visible handle until it is clicked. The rail's group labels moved since the last pass ("What is deployed" now sits under an OPS group of its own).
