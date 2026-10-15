# The Distillation demo

A three-minute story on `/iq/distillation` that a viewer can watch happen:
run notes arrive, a compaction turns them into patterns, people review them
(and reject one), the agreed patterns become a guide, the guide is published,
and an agent runs it. It is a registered mock scenario with a timed director,
the same shape as the Computer Lab demo (`mock/demo-director.ts`).

```bash
# start it (dev:mock middleware on :3001; Tilt's stack)
curl -sXPOST localhost:3001/api/__mock/scenario \
  -H 'content-type: application/json' -d '{"scenario":"distillation-demo"}'
# where it has got to
curl -s localhost:3001/api/__mock/state | jq .distillationDemo
# stop it and put every row back
curl -sXPOST localhost:3001/api/__mock/reset -H 'content-type: application/json' -d '{}'
```

Then open `/iq/distillation/knowledge?view=notes` as a user who holds
ManageBots in orgiq (Nora DaSilva `u-nora`, Eli Garcia `u-eli`) if you want to
take part in the review; any orgiq user can watch.

Knobs (middleware env, read on every beat): `DISTILL_DEMO_PACE_MS` is the
beat length (default 2500 ms); `DISTILL_DEMO_AUTO_DECIDE_BEATS` is how long the
director waits for you on the one pattern it leaves open (default 16 beats; `0`
means it waits for a person indefinitely).

## Why the old demo was weak

The default corpus is careful and honest (counts derived from rows, clock-
stamped, lineage that resolves), but as a demo it is a museum:

- **Nothing happens unless you press a button.** No pass runs on its own
  (the scheduler is off under `dev:mock`, on purpose), so Activity is a list
  of things that finished hours ago and every tier count is still.
- **The only motion is noise.** Simulated ingest mints a copy of each of the
  twelve writers' one template note every minute, so Run notes fills with
  the same twelve titles repeated. That is "L0 is busy", not a story.
- **Review has nothing at stake.** The pending samples are seeded and
  deciding one changes a counter; nothing downstream depends on the verdict.
- **Knowledge does not visibly come from anything or go anywhere.** A guide
  minted by a hand-pressed pass is titled "X (+1 more) (+2 more)", has no
  plain-language line, and nobody ever runs it; the seeded guides' runs
  happened before you arrived.

## What the scenario plays

Three Auth Migration lab sessions — Ada, Basil and Cleo, the Computer Lab
demo's agents on the same three work items (`wi-auth-e2-b3` logout leaves the
shim cookie alive, `wi-auth-e2-s2` tenant-by-tenant cutover, `wi-auth-e1-b4`
refresh loop on a revoked grant) — write what they learn. One of Cleo's lessons
is wrong (retrying the 403 that caused the loop), and review catches it before
it can reach a guide. The script is `middleware/src/mock/distillation-demo-script.ts`;
the director is `middleware/src/mock/distillation-demo.ts`.

Times below are at the default pace (2.5 s beats), measured on the Tilt stack
(see "Verified" below for the transcript).

| t | Knowledge | Review | Activity |
|---|---|---|---|
| 0 s | Default corpus. Run notes 74. | 7 pending, 20 reviewed. | Patterns *behind*, Guides *stalled* (no L1 → L2 pass in 10 h). |
| 5–60 s | A run note every 5 s (12 in all): Basil's cutover decision, Ada's shim-cookie gotcha, an observability note, Cleo's refresh-loop gotcha, … Run notes count climbs live (`orgiq:distill:levels`). | — | Write rate on the ingest panel is the script's own (six sessions). |
| ~65 s | — | — | Nora queues "Compact L0 → L1" for orgiq-auth-service **scoped to the story's 9 notes**; the job runs claim → read → merge → write live (`orgiq:distill:jobs`). |
| ~68 s | Patterns +4: "Cut over the smallest tenant first — one tenant a day (+1 more)", "Logout ended the Cognito session … (+2 more)", "Clear the shim cookie … (+2 more)", "Retry a 403 from the token endpoint three times …". The 3 other-repo notes stay in Run notes. | — | — |
| ~71 s | — | — | Nora queues a pass for orgiq-observability. Its first delivery **fails** at the write step and the job shows *retrying*; the queue redelivers it ~60 s later and it succeeds on attempt 2. |
| ~76 s | — | Pending +4 (the four patterns, "Requested by Nora DaSilva"). | — |
| ~86 s | — | Eli Garcia **agrees** with the gotchas. | — |
| ~96 s | — | Vera Green **agrees** with the cutover decision. | — |
| ~106 s | — | Vera **disagrees** with "Retry a 403 … three times": "This retry is what caused the refresh loop…" | — |
| 106–146 s | — | **Your turn.** "Clear the shim cookie …" waits for a person. Agree or Disagree it in Review; if nobody does in 16 beats, Nora agrees. | — |
| ~151 s | — | — | Nora queues "Compact L1 → L2" scoped to the patterns review agreed with. Guides goes *stalled → behind* (a pass ran; older patterns still wait). |
| ~154 s | Guides +1, a **draft procedure** "Cut over the smallest tenant first — one tenant a day": 5 steps in the order the sessions wrote them, the 3 gotchas as its why, Based on the 3 agreed patterns. The rejected retry lesson is in no guide. | — | — |
| ~162 s | — | Pending +1: the guide itself. | — |
| ~172 s | — | Vera agrees with the guide. | — |
| ~177 s | The guide is **published** with the "when this helps" line Vera writes as she publishes. | — | — |
| ~187 s | The guide's Runs tab: one run by Basil's session (`sess-auth-08`), all steps done → **proven**. Sources → Graph gains the `applied_in` run. | — | — |
| ~192 s | Run notes +1: "Second tenant cut over by following the guide — no forced logouts" — knowledge from runs going back into runs. Director `done`. | — | — |

If you Disagree with the open pattern instead, the guide is built from the two
agreed patterns (still a procedure: the decisions are its two steps).

**Explain this guide** on the published guide goes to Ask, whose canned answer
(`mock/responses.ts`, keyed on "smallest tenant first") walks the five steps
and why they are in that order. It makes no tool call and claims no source: the
guide is in the prompt.

### Side effects worth narrating

- When the gotcha pattern lands in orgiq-auth-service, the existing proven
  auth procedure "Bring SSO up on a new origin" (`art-009`) reads **drifting**
  ("1 new failed/gotcha cluster landed …"). That is the product's drift rule
  (drift is measured per repo at L1), not a demo artefact.
- The earlier draft "Cut one tenant over from SAML to Cognito" (`art-010`)
  stays drifting from its seeded failed run. The new guide's redirect step is
  the fix for that failure; there is no supersede/retire route, so both stay
  listed.

## How it is built (and what it bypasses)

- **Writes go through the provider functions the routes call** —
  `compactNow`, `sampleForReview`, `decideReview`, `publishArtifact`,
  `applyProcedure` — so validation, the queue, and the realtime signals are
  the real ones. Run notes go through a new `recordObservation` (the write
  path an agent's note takes). It is in-process, so it does **not** pass the
  routes' Cedar gate; the people it acts as are named and all hold ManageBots.
- **Three small provider capabilities were added** (all additive, all tested):
  a compaction pass can be **scoped** to named rows (`compactNow(..., { scope })`,
  logged on the job, not on the wire — `input_ids` stays what was claimed);
  `publishArtifact` accepts the plain-language `when_this_helps` (fills an
  empty one only); and a minted L2 title drops the pattern's "(+n more)"
  (a procedure takes its first pattern's headline).
- **The one scripted fault** is the observability pass's first delivery,
  failed through the provider's own `__failNextCompactions` seam, so the
  queue's real redelivery path is what you watch. A Compact you press in the
  same instant could take that failure instead.
- **The world.** Only `distillation-ingest-writers` declares a
  `distillation-demo` branch (the six scripted sessions, each writer's
  `observationsPerHour` counted from the script); every other fixture is
  `default`. Simulated ingest is off in this world: the director is the write
  stream.
- **Lifecycle.** `POST /api/__mock/scenario {"scenario":"distillation-demo"}`
  starts it; `POST /api/__mock/reset`, any other scenario, or pinning a single
  fixture stops it (pending beats are cut short, so a stopped story never
  writes again). A viewer who presses Compact or decides a sample mid-story
  is respected: the director adopts existing samples, never overwrites a
  decided one, and finds the patterns by their member notes whichever pass
  made them.
- **Tests:** `middleware/src/mock/__tests__/distillation-demo.test.ts` (fake
  timers: the whole story; every tier count equals its list; scoped claim;
  retry on attempt 2; who decided what; the guide's steps and sources; proven
  health; realtime signal counts; ingest off and the counted write rate; a
  person's Disagree changes the guide; stop and reset; the scenario plane
  starts it and reset/another scenario stops it).

## In the portal (shipped 2026-10-07)

- **Play it from the landing.** `/iq/distillation/knowledge?nav=distillation`
  shows "Watch the fleet learn" with **Play the demo** to anyone holding
  ManageBots, only when `GET /api/__mock/state` answers (a mock dev server).
  It POSTs the scenario, then shows the director's own progress line, a
  status pill, and a "where to look" button for the current beat
  (`DistillationDemoPanel.tsx`, pure `demoModel.ts`). While it plays:
  **Restart the demo** and **Stop and restore** (a full mock reset).
- **The list follows the tier.** When a tier's `digest` moves (the
  `orgiq:distill:levels` frame, or the poll without a gateway), the Knowledge
  list (and the landing's previews) re-read page 1 in place, keeping rows
  already loaded. New rows wear a **New** pill and are announced through a
  `LiveRegion` ("2 new run notes") (`useKnowledgeItems.ts`,
  `knowledgeModel.freshIds`).
- **The open record follows its row.** A publish, a new "when this helps"
  line or a recorded run shows without a reload (`KnowledgeTab.tsx`,
  `ProcedureRuns.tsx useProcedure(id, version)`).
- **Review marks new samples.** Samples drawn while the queue is open get a
  **New** pill and an announcement. The queue already refetched on a review
  frame.
- **Activity names a retry.** A queued pass in phase `retrying` reads
  **Retrying · delivery 1 failed** in the list. The inspector shows the
  server's own warning line (`activityModel.jobStatus` / `retryReason`).
- **Per-start knobs.** The scenario body takes `paceMs` and `autoDecideBeats`
  (0 means only a person decides the open pattern), the same shape as `demo`'s
  `paceMs`.
- **The walkthrough.** `portal/e2e/distillation-demo.spec.ts` signs in as
  `u-nora`, presses Play, replays the story fast with the open pattern left
  for it, and asserts each beat on the UI while waiting on the director's
  milestones: New run notes, Activity's Retrying, Agree on the open pattern
  (`openDecidedBy: person`), and the published guide's Runs tab ("Latest run
  completed all 5 steps"). Run it against a private BFF and portal pair. A
  second Vite must use its own `cacheDir` inside `portal/node_modules` so it
  never touches the shared dev server's `.vite`.

Not built: a **Publish** button with a "when this helps" field. The provider
takes the field, but the route would need to read it and the write snapshot
would need recapturing. The shared snapshot is already stale from other
lanes' edits, so recapturing it now would not hold.

Out of scope here and recorded as gaps: no route retires or supersedes a
guide (so `art-010` and the new guide coexist); a published-in-app guide never
gets a Library asset (the Library link is seeded only), so the tier graph's
Library count does not move.

## One world at a time

The scenario plane has one global world, so `distillation-demo` and the
Computer Lab's `demo` cannot play at once: starting either (or any reset)
stops the other. A `tsx watch` restart (any edit under `middleware/src`) also
drops the story, because the world is in memory. To record or rehearse
without contention, run a private server on its own port (the same env as the
capture server in `docs/mock-floor.md`, plus `DISTILL_DEMO_PACE_MS`):

```bash
cd middleware && PORT=3071 DISTILL_DEMO_PACE_MS=1000 DEV_OFFLINE=true MOCK_AURORA=true \
  MOCK_AGENTCORE=true MOCK_GUARDRAILS=true MOCK_CLOUDWATCH=true MOCK_QUEUE=true \
  POLICY_STORE_ID= SESSION_SIGNING_SECRET_ARN= NODE_ENV=development AUTH_DEMO_MODE=true \
  npx tsx src/index.ts
```

## Verified (2026-10-07)

A curl walk on such a private server (beat 1 s), polling `/levels`,
`/review`, `/compactions` and `/api/__mock/state` every 10 s:

| time | L0 | L1 | L2 | review pending/decided | director |
|---|---|---|---|---|---|
| before | 74 | 22 behind | 11 stalled | 7 / 20 | idle |
| +10 s | 79 | 22 | 11 | 7 / 20 | writing, 5 notes |
| +20 s | 84 | 22 | 11 | 7 / 20 | writing, 10 notes |
| +31 s | 86 | 26 | 11 | 7 / 20 | patterns minted (comp-91: in 9, out 4); comp-92 running |
| +41 s | 86 | 26 | 11 | 9 / 22 | sampled; comp-92 *queued/retrying* (attempt 1 failed) |
| +62 s | 86 | 26 | 12 behind | 7 / 24 | reviewed (open pattern decided by the director) |
| +72 s | 86 | 26 | 12 | 8 / 24 | guide art-901 minted (comp-93: in 3, out 1) |
| +82 s | 87 | 26 | 12 | 7 / 25 | published, applied |
| +102 s | 87 | 27 | 12 | 7 / 25 | **done**; comp-92 succeeded on attempt 2 |
| reset | 74 | 22 | 11 stalled | 7 / 20 | idle |

The guide read back as `procedure published | Cut over the smallest tenant
first — one tenant a day | Moving a customer's sign-in …`; health
`proven — last proven just now by sess-auth-08; 1 run, all succeeded`; its
lineage held 8 observations → 3 clusters → the artifact, 8 facts and 1
`applied_in` application. `/ingest` reported 6 active writers. On the shared
Tilt :3001 the same scenario started and advanced (2 notes per 10 s at the
default 2.5 s beat) but was reset twice by the Computer Lab demo starting and
once by a `tsx watch` restart, so the full run there is not observed.
