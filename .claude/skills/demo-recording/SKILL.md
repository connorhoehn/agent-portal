---
name: demo-recording
description: Revise and re-record the Computer Lab demo walkthrough (portal/e2e/computer-lab-demo.spec.ts). Use when the demo needs a new act, when a UI change broke a beat, when asked to re-record or restyle the demo, or when a surface the demo crosses has been redesigned.
---

# Revising the demo recording

The walkthrough is a **recorded take of the product working**, not a test and
not a storyboard. Everything on screen is the real portal talking to the real
middleware against mock providers — so when it looks wrong, the usual fix is
the product, not the script.

| | |
|---|---|
| Script | `portal/e2e/computer-lab-demo.spec.ts` |
| Recording config | `portal/playwright.demo.config.ts` |
| What each beat proves, click script, knobs | `docs/demos/computer-lab-demo.md` |
| Output | `portal/e2e-demo/computer-lab-demo-computer-lab-walkthrough/video.webm` (gitignored) |

**The message it exists to carry**, which every revision has to keep: AgentCore
gives you microVMs you can connect to and work inside; work is dispatched
against a budget; agents run on a schedule; and everything an agent writes
passes review.

## The loop

```bash
# 1. Stack up (two terminals)
cd middleware && npm run dev:mock        # :3001
cd portal && npm run dev -- --port 5183  # :5183

# 2. Fast pass while editing — same assertions, ~50s (director beat 1000ms)
cd portal && DEMO_BASE_URL=http://127.0.0.1:5183 DEMO_SLOW_MS=0 DEMO_BEAT_MS=250 npx playwright test --config playwright.demo.config.ts

# 3. The take
cd portal && npx playwright test --config playwright.demo.config.ts
```

Always run step 2 until green before step 3. A failed take still writes a
video, and it is a video of the story stopping halfway.

## Changing what the demo shows

Three different asks, three different answers:

**"This beat is wrong / add a beat."** Edit the spec. An act is a
`test.step` whose comment says *what it proves*, an assertion about the story
(the computer appeared, the gate named itself), and a `beat()` hold so a
viewer can read it. Assert the story, never the markup — anything tighter
breaks the next time the component library restyles a pane.

**"This screen doesn't look how I want."** That is a product change, not a
script change. Fix the surface, then re-record. Component discipline applies
in full: compose from `@connorhoehnslalom/ui-components`, and if the primitive
does not exist, **ship it to the library first** and queue the gap in
`docs/ui-components-queue.md`. Never hand-roll markup in the portal to make a
recording look better — the demo would then be showing something the product
does not have.

**"This is a demo-only concern."** Very few things are. Seed shape is the main
one: which issue, which initiative, which persona. Prefer picking different
seeded rows over inventing new ones, and never flip a fixture's `default`
scenario to make the demo livelier — `middleware/src/mock/bots.ts` has a long
note about exactly that mistake. Ask for a named scenario instead
(`POST /api/__mock/scenario`), or drive the real API on camera the way a user
would.

## Finding selectors after a UI change

Do not guess. Write a throwaway probe, read the DOM, then edit the spec.

```bash
cd portal && cat > e2e/zz-probe.spec.ts <<'EOF'
import { test } from '@playwright/test';
test('probe', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await page.evaluate(async () => {
    await fetch('/api/session/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ userId: 'u-nora' }) });
  });
  await page.goto('/admin/devbox');
  await page.waitForTimeout(3000);
  console.log((await page.locator('body').innerText()).slice(0, 2000));
  for (const b of await page.getByRole('button').all()) {
    console.log('B:', JSON.stringify((await b.textContent())?.trim().slice(0, 46)),
                'aria=', await b.getAttribute('aria-label'));
  }
});
EOF
npx playwright test e2e/zz-probe.spec.ts --reporter=list
rm e2e/zz-probe.spec.ts
```

`zz-*.spec.ts` is gitignored for this purpose. Delete it when done anyway —
`playwright.config.ts` picks up everything in `e2e/`.

## Traps, each one already paid for

- **`getByRole` matches the ACCESSIBLE NAME, not the text.** The bots page
  renders a button reading `Resume` whose `aria-label` is
  `Resume auth-dep-watch`, so `getByRole('button', { name: /^Resume$/ })` finds
  nothing and times out at 90s with no useful message. Scope to the row and
  match text: `page.locator('tr', { hasText: BOT }).locator('button', { hasText: 'Resume' })`.
- **Broad locators hang.** `page.locator('tr, li, div').filter({ hasText })`
  on a full page takes longer than the test timeout. Name one element type.
- **Strict mode fails on plausible-looking text.** `getByText(/agent spend/i)`
  matched both a column label and a value. Add `.first()` when either would do,
  and tighten the pattern when it would not.
- **`page.locator('main')` can match more than one element** and then hang.
  `body` is the reliable thing to dump.
- **The lab restores an open shell.** Clicking `shell` on a pane that already
  has one CLOSES the terminal the next lines type into. Check for the textarea
  first; only click when there is none.
- **409 is the product working.** A money gate refuses with 409 and names the
  flag that would open it. The browser logs every non-2xx as a console error,
  so the walkthrough's console assertion excludes 409 and nothing else. Do not
  widen that exclusion to make a take pass — any other status is a real bug.
- **A two-role persona stops at the workspace picker.** Rachel (`u-rachel`) is
  hr-admin AND org-leader, so she lands on "Choose a workspace" instead of the
  page. Use a single-role persona unless the picker is the beat: `u-nora` (sme),
  `u-hr` (hr-admin), `u-mia` (program-owner), `u-release` (org-leader).
- **Role decides which page exists.** The nav tiers are in
  `portal/src/components/shell/portalCommands.ts`: an SME sees Computer Lab and
  Bots but not Budgets or Changes. Switching persona mid-take is normal and
  reads well — spending and reviewing genuinely are different rights.
- **Only an `open` work item dispatches.** A second take against an item left
  `in_progress` gets a 409. The script resets fixtures first; keep that.
- **Restarting the middleware rebuilds the fleet from the fixture** and drops
  any computer a dispatch minted. Harmless between takes, fatal if `tsx watch`
  reloads mid-recording — don't edit middleware files while recording.

## Pacing

`DEMO_BEAT_MS` (hold per beat, default 1800), `DEMO_SLOW_MS` (pointer
speed, default 260) and `DEMO_PACE_MS` (the demo director's beat, sent as the
scenario's `paceMs`; default ~2.2× the hold, clamped 1–4s). The story is the
`demo` scenario (`middleware/src/mock/demo-director.ts`); a take runs about
four to five minutes. If a beat is too quick to
read, raise the hold for that act specifically — `beat(page, BEAT_MS * 3)` —
rather than slowing the whole recording.

## Before calling a revision done

1. Fast pass green, then a real take.
2. Watch the take. An assertion can pass while the screen shows nothing worth
   watching — that is the one failure mode this script must not have.
3. If a beat now depends on product behaviour that changed, update
   `docs/demos/computer-lab-demo.md` too: the click script and the "known rough edges"
   list are the demo's contract with whoever watches it.
4. Re-check the rough edges in that doc. They are real gaps, and one of them
   getting fixed is a reason to add a beat, not just to delete a line.
