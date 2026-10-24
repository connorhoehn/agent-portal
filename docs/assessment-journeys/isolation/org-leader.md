role: org-leader
user: u-vera
audited: 2026-10-24 14:08–14:08 local, headless Chromium 1680x940 (Playwright), Tilt stack: Vite :5183 over middleware :3001 (dev:mock); mock state not reset (shared stack); a fresh signed-in clone of u-vera (u-vera-clone-45d9ed3c)
session: sub u-vera-clone-45d9ed3c, tenant orgiq, role org-leader, grants {"orgiq":["org-leader","member"],"social":["participant"],"access":["approver"]}
assessment-tile-visible: no        # /api/session/me availableTenants ["orgiq","social","access"]; the word "assessment" appears 0 time(s) on /select
assessment-nav-visible: no         # rail on /iq/projects: 36 anchors, 0 toward /assessment; the word appears 0 times in the page
direct-route-result: redirect      # /assessment/teams → /iq/projects (h1 "All initiatives", 2088 chars of main); /assessment/workspace?doc=page%3A100002 → /iq/projects (h1 "All initiatives", 2088 chars of main); /assessment/prompts → /iq/projects (h1 "All initiatives", 2088 chars of main)
api-status: 403                    # GET /teams 403, GET /knowledge/tree 403, POST /knowledge/canvas 403, GET /knowledge/doc/workflows/comments?id=page%3A100002 403, POST /knowledge/doc/workflows/comments?id=page%3A100002 403, PATCH /knowledge/doc/workflows/comments/kc-rubric-01 403, DELETE /knowledge/doc/workflows/comments/kc-rubric-01 403, POST /knowledge/doc/reaction 403; POST /api/session/tenant {assessment} 403 (session after: u-vera-clone-45d9ed3c/orgiq/org-leader)
screenshot: org-leader.jpg
screenshot-direct-route: org-leader-direct-route.jpg
verdict: pass — walked 2026-10-24: no tile, no nav entry, the direct routes redirect and the assessment REST and document-comment routes answer 403; 0 page errors
notes: Signed in as a clone (POST /api/__mock/identity/clone from u-vera, then POST /api/session/login), so the real persona's session epoch was not touched. Mutating assessment calls were sent only to prove the 403; no row changed. Not re-observed in this pass: the realtime token's refusal to join assessment channels (the 2026-10-08 record has it).
