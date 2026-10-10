surface: review
role: org-leader
user: u-vera (Vera Green) - GET /api/session/me on this walk: sub u-vera, tenant orgiq, role org-leader
url: /iq/distillation/review (lands on /iq/distillation/review?sample=rev-027)
audited: 2026-10-08 08:15 local, headless Chromium 1680x940 (Playwright, fresh context per identity: POST /api/session/login then /role), Tilt BFF :3001 dev:mock via Vite :5183; no mock reset, no write action
screenshot: review.jpg
pages: portal/src/pages/distillation/DistillationModule.tsx,portal/src/pages/distillation/ReviewTab.tsx,portal/src/pages/distillation/SourcesPanel.tsx,portal/src/pages/distillation/ExplainComposer.tsx,portal/src/pages/distillation/AssetRelationships.tsx,portal/src/pages/promotions/PromotionsPage.tsx
verdict: pass - every field below was observed on this walk
console errors: 0 (0 console.error/pageerror across load, the keyboard sweep and the empty-state step)
layout: pass - content col left 44px w 1636px; no horizontal scroll (scrollWidth 1680, innerWidth 1680); body scrollHeight 940 vs 940; 1 <main>; current item "Review"; trail "Build››Distillation››Distillation›Review", 1 visible h1: Cut one tenant over from SAML to Cognito 20px/600; first-row-top: 192px (Guide3; limit 640); clipped-text sweep (strings cut with no title or aria-label ancestor): 0; 54 visible interactive controls
keyboard: pass - physical Tab (page.keyboard, headless) visited 38 distinct controls; 54 visible interactive controls; Escape leaves 0 dialog/menu open; lands on /iq/distillation/review?sample=rev-027; 1 Agree and 1 Disagree controls in <main>
empty-state: pass - "zzznoexist" in the Find a review box renders "No matches"
role-gating: org-leader: ManageBots true; in <main> 0 "Compact" button(s), 1 Agree, 1 Disagree, 0 "Record a run", 0 control(s) matching "Publish" (counted by text). Write actions (Agree/Disagree, Compact) were not exercised
notes: Walked fresh on 2026-10-08 08:15; no field was copied forward. Type-scale ledger (/iq/distillation/review): title 20/600, 10 tracked offender(s) [scale content 10/600; scale content 11/400; scale content 15/400; scale content 16/600; scale content 17/700; scale rail 11/500; scale rail 11/600; scale rail 13/400; scale rail 13/500; siblings rail 11|16]; cascade violations: none. The record title is the page title (one h1 at 20px/600); the verdict pill, kind line and Sources button sit on the title row.
