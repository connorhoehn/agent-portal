# Computer Lab demo — the recorded walkthrough

A single continuous take showing the fleet story end to end, entirely offline:
an SME dispatches a tagged issue, a microVM picks it up, someone works inside
it, the change lands in review, and a cron mission hits the same money gate.

The script is `portal/e2e/computer-lab-demo.spec.ts`; the recording settings
are `portal/playwright.demo.config.ts`. Nothing in it reaches AWS — no
deployed runtime, no Aurora, no Bedrock spend.

## Run it

```bash
cd middleware && npm run dev:mock        # :3001
cd portal && npm run dev -- --port 5183  # :5183, separate terminal
cd portal && npx playwright test --config playwright.demo.config.ts
```

The video lands at `portal/e2e-demo/computer-lab-demo-computer-lab-walkthrough/video.webm`
(1600×900 webm) with a final screenshot beside it. A take runs about a minute
at the default pacing.

Two dials, both environment variables:

| Variable | Default | What it changes |
|---|---|---|
| `DEMO_BEAT_MS` | `1800` | How long each beat holds on screen after it lands |
| `DEMO_SLOW_MS` | `260` | Delay between individual Playwright actions (pointer speed) |

`DEMO_SLOW_MS=0 DEMO_BEAT_MS=250` turns the same walkthrough into a ~20-second
correctness check — worth running after touching any surface it crosses, since
it asserts every beat rather than only recording it.

## What each act proves

1. **The initiative** — Nora DaSilva (`u-nora`, SME) opens Auth Migration:
   owner, SMEs, points, agent spend to date, the repo that delivers it.
2. **Authorize the spend** — a tagged bug goes to the estimate drawer. Model
   tier, forecast range, and how much of *her* sprint envelope it would spend.
   Authorizing is deliberately two-step.
3. **The computer appears** — Computer Lab shows a new microVM under Auth
   Migration, owned by her, running the issue's own title as its task.
4. **Several at once** — the lab is a multiplexer; two computers watched side
   by side.
5. **Inside the microVM** — a shell in `/mnt/workspace` (the persistent
   mount), then `claude "…"` streaming a session with its tool calls, turn
   count, wall time and cost.
6. **Review** — Priya Desai (`u-hr`, hr-admin) sees the captured diff in the
   review queue, carrying the issue title and the initiative it delivers, and
   approves it.
7. **The money** — allocations per initiative, the pot the envelope came from.
8. **Cron** — a parked standing mission is resumed and fired by hand. Its
   forecast overruns its own $0.40 per-run cap, so the brake refuses it and
   names both numbers: a schedule does not exempt a bot from the budget.

## Why the walkthrough asserts

A demo script that silently records the wrong screen is worse than one that
fails, so each act asserts its own beat — the computer appeared, the Claude
session played, the gate named itself. The assertions are about the story, not
the markup; anything tighter would break whenever the component library
restyles a pane.

The take also fails on console errors, with one exclusion: **409**. A money
gate refusing a dispatch answers 409 with the flag that would open it, and act
8 provokes one on purpose — the browser logs every non-2xx, so counting them
blindly would make "the brake fired" look like "the page broke".

## Repeatability

The script resets the fixtures (`POST /api/__mock/reset`) before it starts, so
a second take is not shaped by the first one's dispatch. Restarting the
middleware also rebuilds the fleet from the fixture, which drops any computer a
previous dispatch minted — fine between takes, worth knowing if `tsx watch`
reloads mid-recording.

## Known rough edges

- **The bots page dead-ends on its own gate.** It names the flag
  (`confirmOverRunBudget`) but offers no control to confirm, unlike the
  dispatch drawer, which surfaces the same refusal as a confirmation step.
  The demo uses the refusal as its closing beat; a viewer who asks "so how do
  you proceed?" is asking a fair question.
- **The lab's simulated shell has a generic workspace.** `ls` shows
  `README.md` and `src/`, not the initiative's actual repo — the mock
  filesystem lives in `@connorhoehnslalom/ui-components` (`compute`) and is not
  seeded per box. The README does explain the microVM's persistence model,
  which is on-message for the point the act is making.
