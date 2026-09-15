surface: scores-cohorts
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /iq/scores/cohorts
pages: portal/src/pages/ScoresCohortPage.tsx,portal/src/components/scores
audited: 2026-09-15 07:05 local, Chrome window (innerWidth 1692, innerHeight 858), middleware dev:mock (re-audit after components/scores/WeightSlider.tsx changed under the 9/10 style refactors; signed in as u-rachel via /select → Sign in as → Rachel Kowalski → Org → HR Admin, GET /api/session/me sub u-rachel role hr-admin; every field re-observed)
screenshot: scores-cohorts.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px; breadcrumb "Org › Scores › Cohorts" then the nested "Explore" rail flush with the content box; no horizontal scroll (scrollWidth 1692 = innerWidth 1692); first-row-top: 201px (the first department card, Data Platform, in the six-card grid — no table; only the H1 sits above the grid); the page body does not scroll (scrollHeight 858 = innerHeight 858)
keyboard: pass — 36 tabbable controls and all 36 accept focus (`.focus()` walk)
empty-state: n/a — the seed always has two departments with scored people; there is no filter or search on this page to drive to zero
role-gating: org-leader/hr-admin only (RequireRole in App.tsx) — the histogram, Gini badge, median and named brokers (Theo Chang and Maria Johnson, each touching 3 teams) are data a member never sees
notes: clean page; the two cards are all it holds and both fit in the first 420px of the viewport. Broker names are plain text — a link into /iq/scores/compare or the person's row would be the obvious next step, but nothing on the card claims to be clickable. Re-audit 2026-09-08: renders from `components/scores`, where TrendLine gained a degraded branch (a failed score-history read now says so instead of "No trend data — run the scoring agent"). Cohorts does not mount PersonDetailCard and is unchanged. Re-measured: content col left 224px w 1304px, first cohort heading top 194px (its card at 177px), no horizontal scroll (scrollWidth 1552 = innerWidth), 35 tabbable controls, no failure notice in the DOM, console errors 0; both cohort cards render (Data Platform 5 people median 79.0 Gini 0.05, Platform Engineering 7 people median 79.0 Gini 0.06). Re-audit 2026-09-15 07:05: six department cards (Data Platform 11 · Design Systems 7 · ML / AI 10 · Platform Engineering 14 · Product 8 · Security 6), each with its histogram, Gini chip and Brokers list. Console errors 0.
