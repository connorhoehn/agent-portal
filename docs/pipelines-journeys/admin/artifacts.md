surface: artifacts
role: admin
user: u-operator
url: /pipelines/artifacts
pages: portal/src/pages/pipelines/ArtifactsPage.tsx
audited: 2026-10-08 10:49Z → 2026-10-08 10:49Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-operator, tenant pipelines, role admin, grants {"orgiq":["admin"],"assessment":["admin"],"social":["admin"],"pipelines":["admin"]}
screenshot: artifacts.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Artifacts”; 1 <main>
type: title 20/600; sizes in main (size/weight×text nodes): 14/400×82, 10/600×48, 11/400×24, 12/400×15, 12/600×6, 14/500×1, 20/600×1
keyboard: pass — 28 really-visible focusables in main (27 Tab stops, the rest roving tabindex=-1 members), Tab visited 27; Enter on the first row (focus on TR) opened /pipelines/runs/agent-run%3A79eed77e-7aee-4911-a7ee-d45878eed5eb; browser Back returned to /pipelines/artifacts
empty-state: n/a — no filter value of this table produced an empty result in the live data (nothing to provoke without damaging shared state)
role-gating: pass — admin holds every action. Controls in main: ["Prev","Next"]; Approve/Reject absent from the DOM, Cancel run absent, New definition absent, Configuration rail row present; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 400; PUT /definitions/no-such-definition/approvers {} → 400; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward.  Main text on arrival: Runs › Artifacts Artifacts What runs produced — changes, documents, scores and transcripts. Any kind Change Document Scores Transcript Trace 239 artifacts KIND ARTIFACT RUN RUN STATUS WORKSPACE CREATED Trace Supervisor trace agent-run:79eed
