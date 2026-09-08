surface: scores-cohorts
role: hr-admin
user: u-rachel (Rachel Kowalski) — verified via GET /api/session/me on this surface (sub u-rachel, role hr-admin, tenant orgiq)
url: /iq/scores/cohorts
pages: portal/src/pages/ScoresCohortPage.tsx,portal/src/components/scores
audited: 2026-09-08 03:30 local, Chrome 1552px (innerWidth 1552), middleware dev:mock (re-audit: shares portal/src/components/scores with the trend panel, which changed)
screenshot: scores-cohorts.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Org › Scores › Cohorts" (Scores links back to /iq/scores); nested "Explore" rail flush with the content box at 224px; first-row-top: 194px (the first cohort card, "Data Platform · 5 people · median 79.0 · Gini 0.05" — the two cohort cards ARE the page's content, no table and no summary stack above them); no horizontal scroll (1552 = 1552)
keyboard: pass — 35 controls counted, 35 reached by a 38-press Tab sweep (rail → breadcrumb "Scores" link → nested rail Overview/Cohorts/Compare/Graph → wraps); the cohort cards, histogram bars and broker names are informational text with no click handler, so nothing on the page is mouse-only
empty-state: n/a — the seed always has two departments with scored people; there is no filter or search on this page to drive to zero
role-gating: org-leader/hr-admin only (RequireRole in App.tsx) — the histogram, Gini badge, median and named brokers (Theo Chang and Maria Johnson, each touching 3 teams) are data a member never sees
notes: clean page; the two cards are all it holds and both fit in the first 420px of the viewport. Broker names are plain text — a link into /iq/scores/compare or the person's row would be the obvious next step, but nothing on the card claims to be clickable. Re-audit 2026-09-08: renders from `components/scores`, where TrendLine gained a degraded branch (a failed score-history read now says so instead of "No trend data — run the scoring agent"). Cohorts does not mount PersonDetailCard and is unchanged. Re-measured: content col left 224px w 1304px, first cohort heading top 194px (its card at 177px), no horizontal scroll (scrollWidth 1552 = innerWidth), 35 tabbable controls, no failure notice in the DOM, console errors 0; both cohort cards render (Data Platform 5 people median 79.0 Gini 0.05, Platform Engineering 7 people median 79.0 Gini 0.06).
