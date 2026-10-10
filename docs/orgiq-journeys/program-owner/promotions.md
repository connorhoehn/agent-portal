surface: promotions
role: program-owner
user: u-mia (Mia Singh) — GET /api/session/me on this sign-in: sub u-mia, tenant orgiq, role program-owner
url: /iq/promotions (lands on /iq/distillation/review?view=promotions)
pages: portal/src/pages/promotions,portal/src/pages/distillation
audited: 2026-10-06 12:10 local, headless Chromium 1680x940 (Playwright), Tilt app :5183 / BFF :3001 dev:mock, ui-components 2.413.0, one cookie per role (POST /api/session/login once per role; role set with POST /api/session/role), mock scenarios touched per fixture and restored to default
screenshot: promotions.jpg
verdict: pass
console errors: 0
layout: pass — content col left 200px w 1480px; Distillation rail at x=200 w219, candidate list rail at x=420, the pane at 684, all flush; no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. h1 "Asset promotions" (22px, top 114) is present with and without a candidate open. The list rail is a status select plus "Find a candidate", then rows; first-row-top: 250px (Retry the Data API through an Au…)
keyboard: pass — document-order `.focus()` sweep (headless): 46 of 47 controls accept focus; the refusal is the +N chip. Enter on the focused first candidate opens /iq/distillation/review?view=promotions&item=promo-aurora-cold-start. Typing "Fargate" into Find a candidate at one key per 250ms leaves exactly "Fargate" (URL q=Fargate); the earlier eaten-characters bug does not reproduce
empty-state: pass — "zzznoexist" in Find a candidate → "No candidates in this view"; promotion-candidates on its empty scenario → "No candidates in this view / Candidates appear when observations form a reusable pattern."; on its error scenario → "Could not load asset promotions / 500 … Candidates are clustered from lab observations by the promotions service, so this is unknown rather than empty."; /iq/promotions/zz-bogus → "Candidate not found / No promotion candidate has the id "zz-bogus"" with "← All asset promotions"
role-gating: can read candidates and has "Record approval" and "Dismiss" (not pressed)
notes: The Approve-without-dry-run behaviour (sme DEFECTS #19) was not re-run because it mutates the shared mock. Screenshot before the keyboard sweep.
