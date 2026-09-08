## Before (2026-09-05, middleware stub gateway)

stretch item: agent end-to-end through the fleet
role: lead-assessor
user: u-jonas
tenant: assessment
pages: portal/src/pages/assessment/RunsPage.tsx,portal/src/pages/assessment/dashboard/TeamScorecard.tsx
audited: 2026-09-05, Chrome 1456px, middleware dev:mock
screenshot: agent-e2e.jpg (ledger showing the launched run at "completed" status, top row)
verdict: pass (ledger mechanics) / fail (score application) — the run appears and completes live through SSE exactly as expected, but it writes a scoring log for one dimension only and never touches the scorecard

## Run launch and ledger

On `/assessment/runs`, selected team "Fraud Detection ML (TEAM-006)" (native `<select>`; had to set its value programmatically after `Down`+`Enter` keystrokes failed to register — the on-screen select never visually opened during automation, but the app-level state update worked correctly once the `change` event fired) and clicked **Run** on `score-dimensions`. A toast confirmed "Run started · score-dimensions for TEAM-006."

Without any page reload or navigation (only scrolling within the same SPA view), a new row appeared at the top of the ledger:

- run id: `run-20260905T063742Z-score-dimensions-aae48023a4d3`
- command: `score-dimensions`, team: `TEAM-006`
- appeared with status **running**, started "just now", duration "—"
- polled via `javascript_tool` — by the next check the row had already flipped to status **completed**, duration **0m 08s** (the mock runner's fixed ~8s runtime, matching every other `score-dimensions`/`process-self-assessment` row in the ledger, which all show `0m 08s` too — this looks like a fixed mock delay, not simulated variable work)

This is a real SSE-driven update: the row's appearance, its running->completed transition, and its duration all rendered with zero interaction beyond the initial Run click — no refresh anywhere in this sequence.

## "How it was assessed" — scoring log

Navigated to `/assessment/teams/TEAM-006` -> **How it was assessed** (top-right of the scorecard header). The drawer lists two prior scoring-log runs for this team:

- `20260905T063750Z` — source `mock` (this is the run just launched: `063750Z` is 8s after the ledger's `063742Z` start stamp, consistent with the 0m 08s duration)
- `20260905T051440Z` — source `mock` (an earlier run, ~76 minutes before, corresponding to the `run-20260905T051432Z-process-self-assessment-ecd5e006b425` row visible in the ledger)

Opened the matching `20260905T063750Z` entry. Its content is:

```
Source: mock · No submission envelope
CONTINUOUS INTEGRATION (CI)   [L2]  [moderate]
Mock run — plausible placeholder score for "score-dimensions" (demo data, not a real assessment).
```

Only **one** of the team's 17 dimensions (Continuous Integration) got a log entry, at level **L2** / tone "moderate" — and the log text says outright it is a "plausible placeholder score... demo data, not a real assessment." No envelope, no other dimensions, no rationale beyond that boilerplate line.

## Did the scorecard change?

No. Before and after the run, `/assessment/teams/TEAM-006`'s Certification tab still reads:

- Certification: **Not yet assessed** · 0 of 17 dimensions
- ASSESSED: **0/17**
- Workflow step: still **Intake** (never advanced to Classify/Score/Review)
- Dimension 01 (Continuous Integration — the one dimension the log claims to have scored): still shows **"Not yet verified · no claim on file"**, level **Low**, basis **self-attested**; its own "How it was assessed" tab still reads "Rated low · basis: self-attested. That means it rests on what the team told us, and nothing more." — no mention of the run, no L2, no "moderate."

So the run writes a scoring **log** entry (visible in the drawer, timestamped, tied to the run id) but never calls whatever code path would apply that score to the team's live dimension data. The log and the scorecard are two disconnected surfaces for this command in mock mode.

## Summary

The ledger/ SSE half of "agent end-to-end" genuinely works: launch a run, watch it appear, tick to completion, all live with no reload — this is solid. The "assessment" half does not: `score-dimensions` for TEAM-006 produced a scoring log for exactly one dimension, explicitly labeled placeholder/demo data, and the team's actual scorecard (dimension levels, ASSESSED count, workflow step) was completely untouched by the run. A user watching the ledger would reasonably conclude TEAM-006 got assessed; opening the scorecard shows it didn't.


## After — gateway mode (18080) (2026-09-05, real websocket-gateway on :18080)

stretch item: agent end-to-end through the fleet, re-run against the real gateway, against a team that had never been touched
role: lead-assessor
user: u-jonas
tenant: assessment
audited: 2026-09-05 07:22 local, Chrome 1440px, portal restarted with VITE_GATEWAY_URL=http://localhost:18080, middleware dev:mock
screenshot: agent-e2e.jpg (ledger showing the launched run for TEAM-007 at "completed" status, top row)
verdict: pass (ledger mechanics AND score application) — the run appears and completes live through SSE exactly as expected, and this time it applies a full 17-dimension score set to the team's live scorecard

### Run launch and ledger

On `/assessment/runs`, selected team "Internal Tools (TEAM-007)" — this team was unassessed going in (TEAM-006 was already scored by an earlier run, so TEAM-007 is a clean, never-before-scored subject) — via the native `<select>` (set programmatically through the native value setter + `change` event, same as Before; the on-screen select still doesn't visually open under automation, but the underlying state update fires correctly), and clicked **Run** on `score-dimensions`. A toast confirmed "Run started · score-dimensions for TEAM-007."

Without any page reload or navigation, a new row appeared at the top of the ledger:

- run id: `run-20260905T072242Z-score-dimensions-a5abd12ac353`
- command: `score-dimensions`, team: `TEAM-007`
- appeared with status **running**, started "just now", duration "—"
- polled via `javascript_tool` — the row had already flipped to status **completed**, duration **0m 08s** by the time of the first poll (same fixed ~8s mock runtime noted in Before)

Real SSE-driven update again: appearance, running→completed transition, and duration all rendered live with zero interaction beyond the initial Run click.

### Scorecard — did it change this time?

Yes. `/assessment/teams/TEAM-007` now shows:

- Certification: **L2** — "Working toward Level 3 · verified up to Leve…"
- ASSESSED: **17/17**
- Open follow-ups: **17** (one per dimension, e.g. dimension 01's reads: `No evidence has been submitted for "Continuous Integration (CI)" — can the team describe current practice or link supporting documentation?`)
- Workflow step: **Score** (workflow rail shows Intake ✓ and Classify ✓ both green-checked, Score as the current highlighted step, Review/Publish/Follow-up still pending) — this is a real advance past Before's stuck-at-Intake finding

Levels/confidence across all 17 dimensions (rail, left to right, all confidence **Low**, all basis **self-attested**):

| # | Dimension | Level |
|---|---|---|
| 01 | Continuous Integration (CI) | L1 |
| 02 | Continuous Delivery (CD) | L2 |
| 03 | Automation | L0 |
| 04 | Source Control & Traceability | L1 |
| 05 | Testing & QE – Automated Testing | L2 |
| 06 | Testing & QE – Security Testing | L0 |
| 07 | Testing & QE – Performance & … | L1 |
| 08 | Security Control SDLC & Code … | L2 |
| 09 | Engineering Governance | L0 |
| 10 | Monitoring, Observability & Ru… | L0 |
| 11 | Environment Management | L1 |
| 12 | Release Management & Opera… | L2 |
| 13 | Platform Reusability & Patterns | L0 |
| 14 | Software Development Mindse… | L1 |
| 15 | Agile Planning & Backlog Mana… | L2 |
| 16 | Design Standards & Technical … | L0 |
| 17 | Engineering Metrics & Continu… | L1 |

Distribution: 6× L0, 6× L1, 5× L2 — all confidence "Low" / basis "self-attested" (consistent with a floor-estimate scoring pass with no submitted evidence, not a real evidence-backed assessment — but this time the floor estimates are actually **written to the live scorecard**, not just to an isolated log).

### "How it was assessed" — scoring log

Opened the drawer from the team header. It lists exactly one run: **`20260905T072250Z`**, source `mock`, envelope `—` — the stamp is 8 seconds after the ledger's `072242Z` start time, matching the run's `0m 08s` duration exactly (the run's own summary/duration is what the stamp corresponds to).

Opening that run shows one entry per dimension (17 total, not 1 as in Before). Verbatim, three of them:

> **CONTINUOUS INTEGRATION (CI)** `L1` `low`
> No evidence was found for "Continuous Integration (CI)" — no self-assessment answer, no linked intake evidence. Suggested Level 1 is a floor estimate only, not a verified score.

> **CONTINUOUS DELIVERY (CD)** `L2` `low`
> No evidence was found for "Continuous Delivery (CD)" — no self-assessment answer, no linked intake evidence. Suggested Level 2 is a floor estimate only, not a verified score.

> **AUTOMATION** `L0` `low`
> No evidence was found for "Automation" — no self-assessment answer, no linked intake evidence. Suggested Level 0 is a floor estimate only, not a verified score.

This is a materially different (and more honest) log than Before's single "Mock run — plausible placeholder score... demo data, not a real assessment" line: each of the 17 entries names its own basis (no self-assessment answer, no linked evidence) and calls its own level a floor estimate, not a verified score — and, critically, those floor estimates are the same L0/L1/L2 values now showing on the live scorecard rail above, so the log and the scorecard agree.

### Console errors

0 errors on `/assessment/runs` and `/assessment/teams/TEAM-007` across the whole sequence.

### Summary

Both halves of "agent end-to-end" now work. The ledger/SSE mechanics were already solid in Before and still are. The scoring half is fixed: `score-dimensions` against a genuinely untouched team (TEAM-007) produced a full 17-dimension score set, advanced the workflow step from Intake to Score, set a real ASSESSED 17/17 and a derived L2 certification, and opened 17 explicit follow-ups — and the scoring log's per-dimension rationale (self-attested floor estimate, no evidence) matches what's shown on the scorecard exactly. A user watching the ledger and then opening the scorecard now sees a consistent story, unlike Before's split between "ledger says done" and "scorecard says untouched."
