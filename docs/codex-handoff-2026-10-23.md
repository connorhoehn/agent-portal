# Codex handoff: local dev, remaining work (2026-10-23)

Start in `/Users/connorhoehn/Projects/aws-agentcore`. Everything below runs on
the local Tilt stack. Nothing is deployed, and the default AWS credentials have
been invalid since early October, so do no cloud work. Read `CLAUDE.md` first
for the rules and its "Gotchas". This file lists only what is still open.

## State of the tree

- `main` is clean and **four commits ahead of `origin/main`**:
  `b1b43499`, `e6caccf0`, `ff950293` (Social re-walk, 36 of 48 logs sealed),
  `5e5ae98b`. None of them is pushed. Push only when the user asks.
- Sibling repos are on `main` and clean: platform-api `a88a675`,
  realtime-modules `bb1ebca`, live-video-streaming `11b2a6f`. ui-components
  (`6b94314b`) has one uncommitted file that is not ours, so leave it alone.
- Another agent session ("c9") works in this same worktree. It is fixing the
  overdue `/iq/runbooks/proposals/:pid` type-scale burn-down rows (page edits
  under `portal/src/pages/runbooks`, then pruning
  `portal/e2e/type-scale-burndown.tsv`). Do not edit those files. Before you
  edit source or run `scripts/journeys/measure.sh`, check that c9 is not
  walking or measuring at the same time.

## The local stack

`tilt up` from the repo root (`Tiltfile`) runs these:

| Port | What |
| --- | --- |
| 5183 | portal (Vite) |
| 3001 | middleware, `npm run dev:mock` with `middleware/.env.tilt.local` |
| 23002 | Social platform-api (rooms, teams, calls, recordings), SSH-forwarded from the Colima VM |
| 23001 / 28080 | document platform-api / Yjs gateway (the social-documents containers) |
| 3902 | native SFU |
| 8000 | DynamoDB Local (`orgiq-social-dynamodb`), the platform-api store |

Other pieces:

- **`social-sim`** keeps six seed users (u-lena, u-sana, u-asha, u-jonas,
  u-nora, u-rachel) connected. Never log in as one of them from a browser you
  drive.
- **Docker** runs inside Colima. Reach it with
  `ssh -F ~/.colima/_lima/colima/ssh.config lima-colima 'sudo docker …'`. If
  the VM restarted, run `docker start orgiq-social-redis orgiq-social-dynamodb`.
  To recreate the social containers, use only
  `node scripts/social-documents.mjs up`.
- **Under load** the VM shows platform-api 502s and the portal falls back to
  mock. Retry a bounded number of times, and confirm that list responses say
  `source: "platform"`.

Rules that have cost us before:

- Never run `npm install`.
- Never pattern-`pkill`. Stop only the PIDs you started.
- Never run `POST /api/__mock/reset` on the shared stack. For empty states, use
  `/api/__mock/scenario` and restore it right away.
- Never seal a journey log just to clear a digest mismatch.
- Fixes to platform-api, realtime-modules or ui-components go in that repo, and
  the consumer pin moves afterwards.

## How journeys are walked and judged

- **Walk** with headless Playwright using **identity clones**:
  - Create one with `POST /api/__mock/identity/clone {from,label}`, then sign in
    with `POST /api/session/login {userId}`.
  - Delete it at the end with `DELETE /api/__mock/identity/clone/:id`.
  - A real seed persona may only act as a second context, and you must never
    switch a real persona's tenant: that bumps its session epoch and signs out
    the user's own browser.
  - The rules, walkers and seeding scripts from the last walk are in
    `.scratch/journeys-2026-10-22/social/`: `BRIEF.md`, `lib.mjs`, the
    per-lane `walk.mjs`, and `seed.sh` / `seed-recordings.ts` /
    `unseed-recordings.ts`.
- **Measure, then seal:**
  - `scripts/journeys/measure.sh` re-measures the rendered contracts.
  - `scripts/journeys/seal.sh <dir|log>` seals only passing logs written after
    their contract last changed.
  - Measure signs in as u-operator. If the cascade check fails with "no h1
    after the trail" on `/{iq,assessment,pipelines}/communication`, a clone has
    joined u-operator to a channel. Leave that channel as a u-operator clone,
    for example `POST /api/social/plane/channels/general/leave`.
- **Judges:**
  - `scripts/validate-social-tenant.sh --quick`
  - `scripts/validate-communication-plane.sh`
  - `scripts/validate-assessment-tenant.sh`

## Remaining work, in priority order

### 1. Fix the defects behind the 12 failing Social logs, then re-walk them

The failing logs are the calls, rooms and recordings logs for each role, under
`docs/social-journeys/{participant,moderator,community-admin,admin}/`. The full
write-up is in each role's `DEFECTS.md`, in the section "re-walk of 2026-10-22".

1. **Huddle chat refused on Social calls** (middleware). `HUDDLE_CHAT_TENANTS`
   in `middleware/src/lib/call-access.ts:16-24` admits only orgiq and
   assessment, so `GET /api/calls/<id>/chat` answers 403. Platform-api's
   `POST /api/video/sessions/<id>/call-binding` also answers 403. This produces
   about 11 console errors per calls walk and 13 per rooms walk.
2. **The caller cannot leave a call from the DM it runs on** (portal,
   regression). On the DM, the call dock hides `social-call-dock-header`
   (`display:none`), so it has no Leave, mic or camera control. The dock on
   `/social/calls` works.
3. **A ring cancelled before it is answered writes no call-log row.** Nothing is
   posted to `/api/calls/log/events`.
4. **Recordings never offer Delete** (platform-api). The participant-index rows
   behind `listByUser` carry no `startedBy` (see `participantIndexItems` in
   `~/Projects/platform-api/src/repositories/CallRecordingRepository.ts`), and
   the portal's `mayDeleteRecording` (`portal/src/pages/social/socialPlatform.ts:233`)
   requires it. A DELETE from the starter answers 204, so only the UI is cut off.
   The fix needs a platform-api change plus a container rebuild.
5. **Opening a recording without media logs a 404 console error** (middleware).
   The BFF should answer `mediaState: 'unavailable'`, as its mock path does.
   This alone fails the participant's recordings log.
6. **Real recorded calls cannot be played** (platform-api / SFU). The rows show
   stage failed and `missing-recorded-participant`, with no `startedBy`, and
   playback answers 404 although the SFU wrote media under
   `/tmp/orgiq-media-validation-recordings`.

Recordings walks need seeded rows: `seed.sh` writes `journey-call-*` rows with
`composeStatus 'failed'`. Remove them afterwards with `unseed-recordings.ts`.

### 2. Smaller Social defects

These do not fail any log yet:

- Pressing Escape in the New message picker drops focus to the page body, and
  the picker lists the viewer's own persona.
- An unknown team URL shows no "not found" message.
- The title of the room pane has no left gutter.

### 3. Assessment journey re-walk

c9's Assessment edits made **60 of 61** Assessment logs stale. Nobody has picked
this up. Before starting, tell c9 so it keeps out of Assessment source and does
not run `measure.sh` while you walk. Re-walk with the same clone approach, then
measure, seal, and run `validate-assessment-tenant.sh`.

### 4. Communication judge

All 24 Communication logs are fresh and sealed. The judge is red only on the
four overdue rail-parity type-scale burn-down rows that c9 is fixing now.
Re-run the judge after c9 commits.

### 5. Clean up the shared stack

Tidy these when convenient. Delete only what is plainly journey-made:

- teams and rooms named "Journey …"
- clone DM lobbies
- tagged walk messages
- two real-call recording rows naming u-sana that nobody can delete
  (`2026-10-22T22-57-48-513Z-0827d357`, `2026-10-22T22-59-11-601Z-ebf3424d`).
  Defect 4 has to be fixed before these can be removed.

### Waiting on the user (do not decide)

- Pushing the four local commits.
- Burn-down due dates in `portal/e2e/type-scale-burndown.tsv` and
  `scripts/layout-drift-burndown.tsv`.
- The decisions listed at the top of `CLAUDE.md`: retiring `POST
  /knowledge/doc/comment`, the Alt-click quick panel, Communication landing
  depth, deck save permissions, capacity.
- The three Aurora schema changes that have not been applied.

## Update from c9 (2026-10-24)

- Item 4 is done: the four `/iq/runbooks/proposals/:pid` rows were library
  composites, fixed in ui-components 2.480.5 (`4a892717`, release `98db82a6`,
  local, not pushed). The portal pin moved in `454f8f11` (only the
  ui-components lines; your realtime-modules 0.137.1 lines are still
  uncommitted in the tree) and the burn-down file is now empty. The
  Communication judge's only red is "contracts not measured on the current
  source". c9 did not run `measure.sh`, because the tree holds your
  uncommitted Social work. Measure once that work is committed.
- The live-video-streaming hanging test is fixed at its cause in
  `631d0c0` (local, not pushed): the first Redis connect now fails fast, so
  `_retryConnect` runs and the test skips cleanly with no Redis.
- c9 is not working on Assessment or Social source.
