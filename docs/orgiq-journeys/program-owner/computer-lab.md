surface: computer-lab
role: program-owner
user: u-mia (Mia Singh) — GET /api/session/me on this sign-in: sub u-mia, tenant orgiq, role program-owner
url: /admin/devbox
pages: portal/src/pages/admin/DevboxPage.tsx
audited: 2026-10-06 15:05 local, headless Chromium 1680x940 (Playwright), Vite :5183 / BFF :3001 dev:mock, ui-components 2.419.0, POST /api/session/login as u-mia then role program-owner; devbox-boxes, agent-fleet and compute-nodes set to the empty scenario, then POST /api/__mock/reset
screenshot: computer-lab.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, no horizontal scroll (scrollWidth 1680 = innerWidth 1680); exactly one <main>; clipped-text sweep clean. h1 "Computer Lab" under the Build trail; a blue notice, then the lab frame. first-row-top: 280px (the top of the empty pane — the fleet has no rows for this role, 0 computers · 0 agents, so there is no data row to measure)
keyboard: pass — document-order `.focus()` sweep (headless): 41 of 44 controls accept focus; the refusals are the disabled "Add a pane" and send (⏎) buttons, correctly inert with 0 panes and 0 targets, and the +N chip
empty-state: pass — fleet empty (default for this role, re-confirmed under the empty scenario): both the list rail and the pane read "No computers in the lab / Nothing in the fleet is shared with you yet."; "Nothing matches." appears nowhere with no filter typed (0 nodes). Typing "zzznoexist" into an empty fleet leaves the same empty copy. DEFECTS #29 closed
role-gating: read-only: the notice says "You can see the fleet but not drive it. Opening a shell or dispatching work needs computer access, which an SME or a platform operator can grant."; the "Computer" create button is absent from the DOM, "Keys" remains
notes: Re-walked for defect #29 at 2.419.0; screenshot taken on the empty scenario, 0 console errors, no horizontal scroll (1680/1680), one <main>. The "Nothing matches." filter case with a populated fleet was not re-observed here (this role sees no computers); hr-admin/org-leader/sme logs cover it.
