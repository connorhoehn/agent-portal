surface: bots
role: admin
user: u-operator
url: /pipelines/bots
pages: portal/src/pages/pipelines/BotsPage.tsx
audited: 2026-10-08 10:49Z → 2026-10-08 10:50Z, Chromium (Playwright headless from portal/node_modules, a fresh context per identity, not the shared Chrome tab), 1680×940, Tilt stack: middleware dev:mock on :3001, Vite :5183
session: /api/session/me sub u-operator, tenant pipelines, role admin, grants {"orgiq":["admin"],"assessment":["admin"],"social":["admin"],"pipelines":["admin"]}
screenshot: bots.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1432px, top 70px, bottom 893px; no horizontal scroll (scrollWidth 1680 / innerWidth 1680); h1 “Bots”; 1 <main>
type: title 20/600; sizes in main (size/weight×text nodes): 14/400×78, 10/600×25, 12/600×8, 14/600×2, 14/500×1, 20/600×1
keyboard: pass — 14 really-visible focusables in main (13 Tab stops, the rest roving tabindex=-1 members), Tab visited 13; Enter on the first row (focus on TR) opened /pipelines/definitions?open=bot%3Aa0a4b025-3e67-5004-8b8a-05a3d4f2028d; browser Back returned to /pipelines/bots
empty-state: pass — a read-only list with no filter; /pipelines/bots/does-not-exist renders “Sources › Bots Page not found Nothing lives at /pipelines/bots/does-not-exist. T”
role-gating: pass — admin holds every action. Controls in main: []; Approve/Reject absent from the DOM, Cancel run absent, New definition absent, Configuration rail row present; invalid-body write probes (403 = refused by Cedar, anything else = past the gate, nothing written): PUT /configuration {} → 400; PUT /definitions/no-such-definition/approvers {} → 400; POST /approvals/no-such-step/decide {} → 400; POST /runs/no-such-run/cancel {} → 404
notes: Every field above was observed in this pass, not carried forward.  Main text on arrival: Sources › Bots Bots Read-only Standing missions from the org workspace — each bot is a definition, each firing one of its runs. 12 bots • 77 recorded runs BOT STATE TRIGGER INITIATIVE MODEL RUNS LAST RUN LAST RUN AT a11y-audit-weekly paused
