# Computer Lab demo

Three agents work three items on one initiative, all watched and steered from
the Computer Lab. Everything on screen is the real portal and the real
middleware on mock providers: no AWS, no deployed runtime, no Bedrock spend.

The story is told by the **demo director** (`middleware/src/mock/demo-director.ts`).
It signs in as Nora DaSilva (`u-nora`, SME on Auth Migration) and makes every
pickup through `POST /api/bots/dispatch-work`, so each one crosses the same
Cedar check, grant scope, money gates and concurrency ceiling as a click in the
portal. The computers that appear are the ones those dispatches create. The
director never writes a run, a change or a budget row itself.

| Agent | Item | What happens |
|---|---|---|
| **Ada** · auth-migration-1 | `wi-auth-e2-b3` Logout leaves the legacy shim cookie alive | Works through a plan, finishes, and her change is posted for review |
| **Basil** · auth-migration-2 | `wi-auth-e2-s2` Tenant-by-tenant cutover runbook | Asks a question it cannot settle alone and waits; resumes when a person answers |
| **Cleo** · auth-migration-3 | `wi-auth-e1-b4` Refresh loop on a revoked grant | Finishes, reaches for `wi-auth-e1-s3`, and the sprint-envelope gate refuses it (409 `envelope` / `confirmOverEnvelope`) |

## Start the stack

Either the Tilt stack (`tilt up`: middleware on :3001 in `dev:mock`, portal on
:5183), or by hand:

```bash
cd middleware && npm run dev:mock          # :3001
cd portal && npm run dev -- --port 5183    # :5183
```

Sign in as **Nora DaSilva** (`u-nora`, SME) and open **Build → Computer Lab**
(`/admin/devbox`) before starting the story, so the audience sees the
computers appear.

## Start the story

```bash
curl -s -X POST localhost:3001/api/__mock/scenario \
  -H 'content-type: application/json' \
  -d '{"scenario":"demo","autoAnswer":false}'
```

The scenario resets every fixture first, so it is also the "start over" call.
Knobs, in the request body (each falls back to an environment variable on the
middleware):

| Body field | Env fallback | Default | Effect |
|---|---|---|---|
| `paceMs` | `DEMO_DIRECTOR_PACE_MS` | `4000` | Length of one beat. The whole story is counted in beats: about 3¼ minutes at 4000, about a minute at 1000 |
| `autoAnswer` | `DEMO_DIRECTOR_AUTO_ANSWER_BEATS` (default 20; `0` = never) | auto after 20 beats | `false` means only a person can answer Basil. Use it for a live demo, so the answer is yours |

Where the story has got to: `curl -s localhost:3001/api/__mock/state | jq .demo`
reports the phase, six milestones (`running3`, `questionAsked`,
`questionAnswered`, `captured`, `answerCaptured`, `gateRefused`), who answered
Basil, and the 409 body Cleo received.

## Click script (about five minutes)

Each beat names what to click, what the viewer should see, and the governed
step it crosses.

1. **The lab, before.** Nora is on Computer Lab. *See:* the seeded fleet,
   grouped by initiative in the left rail, with status pills in the header.
   Then run the `curl` above.
2. **Three pickups.** Wait two or three beats. *See:* an **Auth Migration**
   group with three computers named Ada, Basil and Cleo. They show
   provisioning first, then the **running** pill reaches three.
   *Governed:* each pickup is an authorized dispatch against Nora's sprint
   envelope. Computers are created by the dispatch, not by the director.
3. **Inside Ada's computer.** Click **Ada** in the rail. *See:* a shell pane on
   her microVM at `/mnt/workspace`; type `ls`. *Point:* it is a computer you can
   connect to and work inside.
4. **Ada's plan.** Open the pane menu (**Shell ▾**) and choose **Agent**.
   *See:* the run's latest plan as a checklist ("Plan · 2 of 6 done", counting up) with
   each tool step beneath it.
5. **Cleo's logs.** Use the open-in-new-pane icon on **Cleo**'s rail row, then
   switch that pane to **Bot logs**. *See:* her run streaming as log lines.
6. **The money gate.** When Cleo finishes, switch her pane to **Agent**.
   *See:* "Done with that one. Picking up the next open item…" followed by a
   warning row: **Held at the envelope gate · Session cookie hardening**. The
   row gives the forecast, what is left of the $0.70 envelope, and
   `needs confirmOverEnvelope`. *Governed:* the money brake. A run that would
   overrun the envelope is refused and the refusal names the flag that would
   allow it.
7. **Basil needs you.** The **need you** pill counts Basil. Open Basil in a new
   pane and switch to **Agent**. *See:* his plan stopped at "Settle the cutover
   order", plus a **Needs you** box with his question. Type an answer in the
   reply box (for example "Smallest tenant first") and press **Reply**.
   *Governed:* the answer resumes the task on Basil's own session through
   `POST /api/devbox/:sessionId/task`, the ManageDevbox-gated route. The same
   path works from **Nudge** with Basil as the target.
8. **Basil resumes.** *See:* your answer in his transcript, a new run, and the
   plan completing.
9. **Changes posted for review.** *See:* **Change posted for review** rows with
   the commit sha on Ada's pane, and on Basil's when he finishes.
   *Governed:* capture → independent review → policy gate. The agent leaves
   its change uncommitted and the platform commits it.
10. **The reviewer.** Switch persona to Priya Desai (`u-hr`, hr-admin) and open
    **Changes** (`/admin/changes`). *See:* Ada's and Basil's changes, each titled
    with its work item and "delivering Auth Migration". *Point:* spending and
    reviewing are different rights.

## Reset

```bash
curl -s -X POST localhost:3001/api/__mock/reset
```

This stops the director and returns every fixture, including the fleet, to the
seed. Switch back to your own persona afterwards. The persona switch affects
the browser you used.

## The recorded walkthrough

`portal/e2e/computer-lab-demo.spec.ts` plays this script in one take and
asserts each beat against the UI. It cross-checks the director's milestones at
`/api/__mock/state` and confirms that the review queue (`GET /api/sdlc/changes`)
holds both changes. It answers Basil from the Agent pane with `autoAnswer:
false`, so the person-answered beat is real. It resets the fixtures when it
finishes.

```bash
cd portal
# Fast pass: same assertions, about 50s. The director's beat defaults to 1000ms here.
DEMO_BASE_URL=http://127.0.0.1:5183 DEMO_SLOW_MS=0 DEMO_BEAT_MS=250 npx playwright test --config playwright.demo.config.ts
# The take: 1600×900 video at e2e-demo/computer-lab-demo-computer-lab-walkthrough/video.webm
DEMO_BASE_URL=http://127.0.0.1:5183 npx playwright test --config playwright.demo.config.ts
```

| Variable | Default | Effect |
|---|---|---|
| `DEMO_BEAT_MS` | `1800` | How long each beat holds on screen |
| `DEMO_SLOW_MS` | `260` | Pointer speed (Playwright `slowMo`) |
| `DEMO_PACE_MS` | about 2.2 × `DEMO_BEAT_MS`, clamped to 1000–4000 | The director's `paceMs`, sent in the scenario body |

Revising it is covered in `.claude/skills/demo-recording/SKILL.md`.

## Known rough edges

- **The middleware server is shared.** Another session's `POST /api/__mock/reset`
  or scenario call, or a `tsx watch` reload of the middleware, ends the story
  partway through. The director goes `idle` and the computers revert to the
  seed. Don't edit middleware files while recording.
- **The lab opens on the first seeded computer**, which is observability-1 and
  is itself waiting. As a result the **need you** pill reads 2 while Basil
  waits, and the presenter has to click into Ada. The lab has no way to show a
  freshly dispatched group first. `?box=<id>` works only once you know the
  computer.
- **The gate refusal can't be acted on from the lab.** Cleo's row names
  `confirmOverEnvelope` but has no control to confirm it. Proceeding means
  dispatching again from the work item's Run setup.
- **No PR link offline.** The delivery row shows the commit sha. The mock
  pipeline does not open a pull request, so the row's PR link slot stays empty.
- **Turn summaries show `0s` wall time** ("10 turns · 0s · $0.21"), because the
  mock runs report no duration.
- **Ada's shell is the generic simulated workspace** (`README.md`, `src/`), not
  the initiative's repository. The mock filesystem lives in the library and is
  not seeded per computer.
- **The review queue supersedes Ada's change.** All three agents deliver to
  `orgiq-auth-service`, and the queue keeps one live change per codebase. When
  the reviewer looks, Ada's and Cleo's changes are marked *superseded* and
  Basil's later one is already *approved* (offered as "Deliver as pull
  request"). Ada's change is visible but can't be approved. Either the agents
  need separate codebases, or the pipeline needs to stop superseding changes for
  different work items. This is a middleware/SDLC decision and is not fixed here.
