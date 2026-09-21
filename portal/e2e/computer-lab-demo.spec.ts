// The Computer Lab walkthrough — a recorded demo, not a correctness test.
//
// WHAT IT SHOWS, in one continuous take:
//   1. An SME opens an initiative and dispatches a tagged issue to an agent.
//   2. The money gates decide whether that dispatch is allowed to spend.
//   3. A computer — an AgentCore microVM — appears in the lab running it.
//   4. The SME opens several computers at once and works in one: a shell in
//      the microVM's persistent workspace, and a Claude session in it.
//   5. The run's change arrives in the review queue, bound to the issue.
//   6. Cron: a standing mission on a schedule, braked by the same gates.
//
// WHY IT IS ONE TEST. Playwright records one video per test, so splitting the
// acts would produce six clips of a story that only makes sense in order.
// `test.step` keeps the structure legible in the reporter without cutting the
// tape.
//
// It asserts as it goes — a demo that silently records the wrong screen is
// worse than one that fails — but the assertions are about the STORY beats
// (the computer appeared; the gate named itself), not about markup. Anything
// tighter would break every time the library restyles a pane.
//
// Run it:
//   cd portal && npx playwright test --config playwright.demo.config.ts
//
// Needs the offline stack: middleware `npm run dev:mock` on :3001 and the
// portal on :5183. It talks to nothing else — no AWS, no deployed runtime.

import { test, expect, type Page } from '@playwright/test';

/** The tagged issue the SME dispatches. Open, small, and labelled, so the
 *  board shows the tags the story is about. */
const ISSUE = {
  id: 'wi-auth-e2-b3',
  title: 'Logout leaves the legacy shim cookie alive',
  initiative: 'p-auth-migration',
  initiativeName: 'Auth Migration',
};

/** A seeded cron bot on the same initiative — `schema/seed_program.sql` parks
 *  every bot, which is the state the cron beat starts from. */
const CRON_BOT = 'auth-dep-watch';

/** How long a beat holds on screen after it lands, so a viewer can read it.
 *  This is the pacing dial for the whole recording. */
const BEAT_MS = Number(process.env['DEMO_BEAT_MS'] ?? 1800);

async function beat(page: Page, ms = BEAT_MS): Promise<void> {
  await page.waitForTimeout(ms);
}

/**
 * Become one of the seeded people.
 *
 * The demo-mode picker endpoint, not the SSO flow: offline there is no Cognito
 * and this is the same call the portal's own user picker makes. Each switch
 * hard-navigates afterwards, because the app tears down in-memory state on a
 * context change and a soft route push would leave the previous person's data
 * on screen mid-recording.
 */
async function signIn(page: Page, userId: string): Promise<void> {
  await page.goto('/');
  await page.evaluate(async (id: string) => {
    await fetch('/api/session/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ userId: id }),
    });
  }, userId);
}

/**
 * Put the fixtures back.
 *
 * Every take starts from the same board, the same fleet and the same parked
 * bots, so a second recording is not shaped by the first one's dispatch. This
 * is the control plane's own reset (`docs/mock-floor.md`) rather than a
 * restart, so it is fast and leaves the dev server alone.
 */
async function resetFixtures(page: Page): Promise<void> {
  await page.request.post('/api/__mock/reset').catch(() => null);
}

test('computer lab walkthrough', async ({ page }) => {
  // A page that threw on camera is a re-take, not a footnote — so the
  // walkthrough watches its own console.
  //
  // 409 is EXCLUDED, and that is not a loophole. A money gate refusing a
  // dispatch answers 409 with the flag that would open it (`lib/bot-runner.ts`
  // decideRunBudget / decideAllocation / decideEnvelope), and Act 8 provokes
  // one deliberately: the browser logs every non-2xx as a console error, so
  // asserting on a bare count would make "the brake fired" indistinguishable
  // from "the page broke". Every other status still fails the take.
  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/status of 409/.test(m.text())) return;
    consoleErrors.push(m.text());
  });

  await test.step('Reset to the seeded world', async () => {
    await page.goto('/');
    await resetFixtures(page);
  });

  await test.step('Act 1 — the SME opens her initiative', async () => {
    await signIn(page, 'u-nora');
    await page.goto(`/iq/projects/${ISSUE.initiative}`);
    // The header carries the story's framing: who owns it, who the SMEs are,
    // how much agent spend it has drawn, and which repo delivers it.
    await expect(page.getByText(ISSUE.initiativeName).first()).toBeVisible();
    await expect(page.getByText(/agent spend/i).first()).toBeVisible();
    await beat(page, BEAT_MS * 2);
  });

  await test.step('Act 1 — find the tagged issue on the board', async () => {
    // Narrow to what is actually dispatchable. `Open` is the only status a
    // dispatch will accept — an in-progress item 409s, which is a fine thing
    // for the product to do and a poor thing to record.
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await beat(page);
    await expect(page.getByText(ISSUE.title)).toBeVisible();
    await beat(page);
  });

  await test.step('Act 2 — authorize the spend', async () => {
    // The row's own dispatch affordance. Scoped to the issue's row so the
    // recording cannot wander onto a different item when the board reorders.
    const row = page.locator('tr', { hasText: ISSUE.title });
    await row.getByRole('button', { name: /Run/ }).click();

    // The estimate drawer is the money surface: the model tier, the forecast
    // range, and — the part worth pausing on — how much of THIS person's
    // sprint envelope the run would spend. Nothing here is a static number;
    // each one is computed against the seeded grants and run history.
    const authorize = page.getByRole('button', { name: /^Authorize$/ });
    await expect(authorize).toBeVisible();
    await expect(page.getByText(/envelope/i).first()).toBeVisible();
    await beat(page, BEAT_MS * 2);

    // Sonnet rather than the default Haiku: a multi-step code change is what
    // the demo is about, and the tier visibly moves the forecast the gates
    // then judge.
    const sonnet = page.getByText(/^Sonnet —/);
    if (await sonnet.isVisible().catch(() => false)) {
      await sonnet.click();
      await beat(page);
    }

    await authorize.click();
    // Authorizing is a two-step on purpose: the confirmation restates what is
    // about to be spent, against which item, and that the change still faces
    // review. A gate may answer here instead — the per-run cap, the
    // initiative's allocation, or the envelope — each naming itself and the
    // confirmation that opens it, so the recording shows the brake working
    // and then shows someone deciding to spend anyway.
    const confirm = page.getByRole('button', {
      name: /^(Authorize run|Dispatch anyway|Authorize anyway|Confirm)/i,
    });
    await expect(confirm).toBeVisible();
    await beat(page, BEAT_MS * 2);
    await confirm.click();
    await beat(page, BEAT_MS * 2);
  });

  await test.step('Act 3 — the computer appears in the lab', async () => {
    await page.goto('/admin/devbox');
    // The fleet is grouped by initiative, so the computer this dispatch minted
    // lands under Auth Migration next to the ones already there. It carries
    // the issue's own title as its current task — that is the whole point of
    // the beat: work dispatched from the board shows up as a machine doing it.
    await expect(page.getByText(/computers/i).first()).toBeVisible();
    await expect(page.getByText(ISSUE.initiativeName).first()).toBeVisible();
    await expect(page.getByText(ISSUE.title).first()).toBeVisible({ timeout: 30_000 });
    await beat(page, BEAT_MS * 2);
  });

  await test.step('Act 4 — open several computers at once', async () => {
    // The lab is a multiplexer, not a list with a terminal behind it. Watch
    // two computers at once: this is the affordance the surface exists for.
    const watchButtons = page.getByRole('button', { name: /^Watch / });
    const count = await watchButtons.count();
    for (let i = 0; i < Math.min(count, 2); i += 1) {
      await watchButtons.nth(i).click();
      await beat(page, 900);
    }
    await beat(page);
  });

  await test.step('Act 5 — work inside the microVM', async () => {
    // The lab restores an open shell, so this opens one only when there is
    // none — clicking `shell` on a pane that already has one would close the
    // terminal the rest of this act types into.
    const terminal = page.locator('.xterm-helper-textarea, textarea').first();
    if (await terminal.count() === 0) {
      await page.getByRole('button', { name: /^shell$/ }).first().click();
      await beat(page);
    }
    await terminal.click({ timeout: 10_000 });

    // `/mnt/workspace` is the microVM's persistent mount, and the README in it
    // says so in as many words — which is why it is worth opening on camera
    // rather than just listing the directory.
    for (const command of ['ls', 'cat README.md']) {
      await page.keyboard.type(command, { delay: 55 });
      await page.keyboard.press('Enter');
      await beat(page, 1600);
    }

    // The centrepiece: a Claude session running INSIDE the microVM, streaming
    // its tool calls, turn count, wall time and cost the way a real one does.
    await page.keyboard.type('claude "clear the legacy shim cookie on logout"', { delay: 45 });
    await page.keyboard.press('Enter');
    // Assert the session actually played. Without this the recording could
    // show an empty prompt and still pass, which is the one failure mode a
    // demo script must not have.
    await expect(page.getByText(/done · \d+ turns/)).toBeVisible({ timeout: 30_000 });
    await beat(page, BEAT_MS * 2);
  });

  await test.step('Act 6 — the change reaches the review queue', async () => {
    // A different person, because reviewing is a different right: an SME
    // spends an envelope, a platform operator decides what lands. Priya holds
    // one role, so this lands straight on the page — Rachel (hr-admin AND
    // org-leader) would stop at the workspace picker, which is correct
    // behaviour and a detour in a recording.
    await signIn(page, 'u-hr');
    await page.goto('/admin/changes');
    // The run captured a diff, and it arrived carrying the issue's own title
    // and the initiative it delivers — the governed half of "an agent did
    // some work". Nothing here was hand-written for the demo: the diff came
    // out of the workspace the run actually touched.
    const change = page.locator('*', { hasText: ISSUE.title }).last();
    await expect(page.getByText(ISSUE.title).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/delivering Auth Migration/i).first()).toBeVisible();
    await beat(page, BEAT_MS * 2);
    void change;

    // Close the loop on camera: a human approves what the agent wrote.
    const approve = page.getByRole('button', { name: /^Approve$/ }).first();
    if (await approve.isVisible().catch(() => false)) {
      await approve.click();
      await beat(page, BEAT_MS * 2);
    }
  });

  await test.step('Act 7 — the money behind it', async () => {
    await page.goto('/admin/budgets');
    // Allocation per initiative, and what has been spent against it. This is
    // the pot the SME's sprint envelope was carved out of two acts ago.
    await expect(page.getByText(ISSUE.initiativeName).first()).toBeVisible({ timeout: 20_000 });
    await beat(page, BEAT_MS * 2);
  });

  await test.step('Act 8 — cron: the standing mission, and its brake', async () => {
    await page.goto('/admin/bots');
    // Every seeded bot ships PARKED — they would otherwise fire at repos that
    // do not exist yet — so un-pausing one is how scheduled maintenance
    // starts, and it is a truthful thing to do on camera rather than a
    // fixture pretending the fleet was already busy.
    const row = page.locator('tr', { hasText: CRON_BOT });
    await expect(row).toBeVisible();
    await beat(page);

    await row.locator('button', { hasText: 'Resume' }).click();
    await expect(row.getByText('enabled')).toBeVisible({ timeout: 15_000 });
    await beat(page);

    // Firing it by hand takes the SAME gates a person's dispatch takes: this
    // bot's forecast overruns its own $0.40 per-run cap, so the brake refuses
    // it and names both numbers. A standing mission is not exempt from the
    // money just because a schedule started it.
    await row.locator('button', { hasText: 'Run now' }).click();
    await expect(page.getByText(/exceeds the per-run budget/i)).toBeVisible({ timeout: 20_000 });
    await beat(page, BEAT_MS * 3);
  });

  expect(consoleErrors, `console errors during the walkthrough:\n${consoleErrors.join('\n')}`)
    .toHaveLength(0);
});
