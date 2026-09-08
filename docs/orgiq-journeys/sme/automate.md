surface: automate
role: sme
user: u-nora (Nora DaSilva) — GET /api/session/me on this sign-in: sub u-nora, tenant orgiq, role sme
url: /iq/work
pages: portal/src/pages/work
audited: 2026-09-06 11:04 local, Chrome 1552×789, middleware dev:mock
screenshot: automate.jpg
verdict: pass
console errors: 0
layout: pass — content col left 224px w 1304px; breadcrumb "Build › Automate"; nested "Automate" rail (Run: Overview / Queue / Findings · Configure: Bots) flush with the content box (aside right edge 444px, inner content at 468px w 1060px); no table on this Overview — first-row-top: 293px for the first roster row ("obs-nightly-maintenance · Observability Platform") of BOTS PULLING FROM THIS QUEUE, with one 4-tile strip (Waiting / Processing / Est. to drain / Bots on this queue) above it and a second 4-tile strip (Needs you / Workers / Findings + DLQ / Rediscovery avoided) plus the one-sentence description and the "Nothing needs your attention right now" panel below; no horizontal scroll (scrollWidth 1552 = innerWidth)
keyboard: pass — 36 tabbable controls, none with tabIndex −1, all reached in a 42-press Tab sweep (focus-log diff: missing none): rail group toggles + Overview / Queue / Findings / Bots, "Graph updates →" (/iq/work/changes), "Manage bots →" (/admin/bots), the five roster rows (real `<a href="/admin/bots/<uuid>">`), the WORKERS and FINDINGS + DLQ tile buttons, the inline "queue" (/iq/work/queue) and "Computer Lab" (/admin/devbox) links, then the shell
empty-state: pass — every tile reads its own zero (WAITING 0, PROCESSING 0, EST. TO DRAIN clear, NEEDS YOU 0 "0 for review · 0 graph changes · 0 agent questions", WORKERS 0 "all idle — the next queued job dispatches within ~10s") and the review lane says "Nothing needs your attention right now"; the roster shows the five seeded bots with idle / paused pills, cron lines and "ran Nh ago · 0/4 today"
role-gating: sme gets the full bot roster (5 bots, 1 paused), the Configure → Bots rail entry and "Manage bots →" (ManageBots true for sme, bots is in-matrix), and a live "Computer Lab" link (ManageDevbox); nothing on this page is denied to sme, and no allocate / approve control exists here for any role
notes: same shape as the 2026-09-05 pass. Two four-tile strips plus a roster is a lot of chrome for five zeros, and the captions "1 paused · every run passes review gat…", "0 for review · 0 graph changes · 0 age…", "all idle — the next queued job dispatch…" and "2 short-circuits · 1 dismissed …" all truncate at this width; the "Nothing needs your attention right now" panel sits at the bottom edge of the viewport (its heading at ≈756px) so the review lane the page is for is the last thing seen.
