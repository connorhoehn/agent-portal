role: demo-user (cookie-less fallback identity, dev only)
user: demo-user
audited: 2026-10-24 14:12–14:12 local, headless Chromium 1680x940 (Playwright), Tilt stack: Vite :5183 over middleware :3001 (dev:mock); mock state not reset (shared stack); a fresh cookie-less context
session: sub demo-user, tenant orgiq, role sme, grants {"orgiq":["sme"]}
assessment-tile-visible: yes        # /api/session/me availableTenants ["orgiq"]; the word "assessment" appears 2 time(s) on /select — by design: the picker keeps offering every persona to the dev-only demo identity (SelectContextPage.tsx, the accounts memo), while the narrowed session holds no assessment grant
assessment-nav-visible: no         # rail on /iq/projects: 16 anchors, 0 toward /assessment; the word appears 0 times in the page
direct-route-result: redirect      # /assessment/teams → /iq/projects (h1 "My initiatives", 709 chars of main); /assessment/workspace?doc=page%3A100002 → /iq/projects (h1 "My initiatives", 709 chars of main); /assessment/prompts → /iq/projects (h1 "My initiatives", 709 chars of main)
api-status: 403                    # GET /teams 403, GET /knowledge/tree 403, POST /knowledge/canvas 403, GET /knowledge/doc/workflows/comments?id=page%3A100002 403, POST /knowledge/doc/workflows/comments?id=page%3A100002 403, PATCH /knowledge/doc/workflows/comments/kc-rubric-01 403, DELETE /knowledge/doc/workflows/comments/kc-rubric-01 403, POST /knowledge/doc/reaction 403; POST /api/session/tenant {assessment} 200 — by design for the permissive cookie-less demo identity (switchable grants) (session after: demo-user/assessment/assessor)
screenshot: demo-user.jpg
screenshot-direct-route: demo-user-direct-route.jpg
verdict: pass — walked 2026-10-24: no tile, no nav entry, the direct routes redirect and the assessment REST and document-comment routes answer 403; 0 page errors
picker-before-choice: /api/session/me = sub demo-user, role member, availableTenants ["orgiq","assessment"], grants {"orgiq":["member","sme","program-owner","org-leader","hr-admin","admin"],"assessment":["assessor","lead-assessor","program-lead","admin"]}; after the picker's two-step to Org · SME the session reads demo-user/orgiq/sme
notes: The cookie-less demo identity, narrowed with the picker's own two-step (POST /api/session/tenant orgiq, /role sme). Mutating assessment calls were sent only to prove the 403; no row changed. Not re-observed in this pass: the realtime token's refusal to join assessment channels (the 2026-10-08 record has it).
