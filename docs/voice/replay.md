# Voice replay suite

`portal/src/lib/voice/__tests__/realSessions.test.ts` plays the owner's real voice sessions back through today's controller and checks the invariants the gaps doc (`docs/voice-navigator-gaps.md`) established. Its input is `portal/src/lib/voice/__tests__/fixtures/real-sessions.json`, written from the middleware's session logs by `scripts/voice/sessions-to-replay.mjs`.

## Regenerating the fixture after new sessions

```sh
node scripts/voice/sessions-to-replay.mjs           # reads middleware/.voice-log/*.jsonl, rewrites the fixture
node scripts/voice/sessions-to-replay.mjs --check   # exit 1 when the fixture is stale
node scripts/voice/sessions-to-replay.mjs --log <dir>   # another log folder (from a worktree the default is the main checkout's)
cd portal && node --test src/lib/voice/__tests__/realSessions.test.ts
REPLAY_DEBUG=all node --test src/lib/voice/__tests__/realSessions.test.ts   # or a comma list of session prefixes
```

`REPLAY_DEBUG` prints every replayed call: its log seq, the user turn, how the log says it ended and how the replay ended, plus each invariant break and the calls refused before they run.

A session counts as real when its log has a `sideband` row (a Live API connection; the middleware's own tests and the mock mint have none) and at least one delegation or tool result. After a regeneration, a new session either passes or shows a break. If it is a product bug, write it as a `test.todo` with the session id, seq and evidence until it is fixed, as G64 was. If a new up-front refusal is right, add it to `UP_FRONT`, which pins every call today's controller refuses before it runs.

## What the fixture keeps

For each session: its tenant, the minted tool list and the ordered delegations. Each delegation records whether the user had the floor before it, and each call records:

- the tool and its argument shape (`argShape`: enum values, a ref's kind, counts)
- a 12-hex prefix of the argument hash
- the outcome, with the refusal reason or failure code and the result counts
- the card: who it was for, and whether it was confirmed by voice or click, cancelled or never answered

The fixture also lists the stops and how the session closed. Timings are milliseconds from the session start, rounded to 100 ms. It holds no words: the script copies only whitelisted keys, and `assertNoWords` refuses to write any string that isn't a closed-vocabulary token. Sessions from before the dock logged delegations (8 November, before 23:30) only have tool-result rows. For those, calls less than 3 s apart are grouped into one delegation, marked `inferred`.

## How a session is replayed

- **The model** makes the logged calls in order on the scripted mint. The first call arrives with the delegation and each later one in the continuation that follows a `response.create`. When the user had the floor, an input transcript plays before the delegation (a new user turn, as in the controller).
- **Arguments** are rebuilt from the shape. Enum values are used as logged, a ref becomes `<kind>:<hash prefix>`, and free text becomes "Replay words <hash prefix>". Equal logged arguments therefore stay equal, and any word that reaches the event log is caught. A read of the kind just opened reuses that record's ref (vs_5144e356). A message goes to the conversation the session last opened.
- **Runners and planners** answer as the log says: done, refused with the logged reason, failed with the logged code, or an ambiguous list with the logged candidate count. A refusal the log gives without a reason, or as `other`, goes to the real runner or planner on the rebuilt arguments, so invariant (e) tests today's code. A call the old dock refused by its own gate (navigated, too-many-calls) runs if today's controller lets it through.
- **Cards** are answered as the user answered them, by voice ("Confirm.", "Cancel that.") or by click, after the logged wait capped at 1.5 s.
- **The probe:** after the last delegation, one more request (a `list`) must be answered.

## The invariants and what each protects

| | Invariant | Protects against |
|---|---|---|
| a | Every tool output is followed by a `response.create`, including in stopped rounds and past `delegation-stuck`; no runaway restart | G59: a delegation that isn't continued never resolves, and the Live API keeps the voice silent for the rest of the session (vs_d69bbb23, vs_5144e356) |
| b | Every logged delegation reaches the dock, and one more request after the last is answered | The session going deaf for any reason |
| c | At most four calls run per user turn; after a navigation only a read of that page runs | G43 (vs_f86d7b03: eight calls in 28 s); G51 (vs_d69bbb23: four pages in one request) |
| d | An action call that ran shows exactly one card or rides a G41 cover; a failed post never reuses the cover | G41 fewer cards without losing a confirm; sweep 7's retried-message fix |
| e | Refusals carry a reason other than `other`; failures carry a code | G42 and G47: the log and the voice can say why |
| f | The second identical refused call in a turn is terminal, and a third never runs | G29 retry loops (vs_a215e96c) |
| g | The event log the replay posts holds only closed-vocabulary tokens, with no canary words | §9: no transcript or argument text leaves the dock |

The suite also pins named regressions: G51 and its follow-up, G43 with G59, G48 with G41, G42, G62, and the up-front refusal table.

## Bugs the replays exposed (fixed as G64)

- **B1, delegation-stuck went deaf** (vs_d69bbb23 seq 193, vs_f86d7b03 59, vs_9b06806f 50, vs_a215e96c 14). If the model made a third call after a stop, `maybeContinue` closed the delegation without a `response.create`: the G59 hang again. Every output is now continued; a model still calling after `MAX_RUNAWAY_CONTINUATIONS` gets the session restarted.
- **B2, `open { page, tab }` was refused as `other`** (vs_9b2868a7 seq 7). A page now opens on a tab it is known to have; otherwise the refusal is `invalid-arguments` with the forms that work.
- **B3, dispatch refusals had no code** (vs_d69bbb23 seq 157). `planDispatch` now says `not-dispatchable` (with why) or `not-on-initiative`.
