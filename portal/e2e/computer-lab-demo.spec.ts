// The Computer Lab walkthrough — a recorded demo, not a correctness test.
//
// WHAT IT SHOWS, in one continuous take, all inside the Computer Lab:
//   1. Nora DaSilva (u-nora, SME on Auth Migration) has the lab open. Three
//      agents — Ada, Basil and Cleo — pick up three open items on the
//      initiative, and three computers (AgentCore microVMs) appear under it.
//   2. She opens Ada's computer: a real shell in its persistent workspace, then
//      the Agent view — the run's plan as a checklist, step by step.
//   3. Cleo's Bot logs stream; Cleo finishes, reaches for the next item, and
//      the sprint-envelope money gate refuses it — naming itself and the flag.
//   4. Basil asks a question it cannot answer alone. Nora answers FROM THE LAB
//      (the Agent pane's inline reply) and Basil resumes.
//   5. Ada's change is posted for review; the reviewer sees it in the queue.
//
// WHERE THE STORY COMES FROM. `POST /api/__mock/scenario {"scenario":"demo"}`
// starts the demo director (middleware/src/mock/demo-director.ts). Every pickup
// is a real `POST /api/bots/dispatch-work` as Nora, so the computers on screen
// are the ones the governed dispatch minted, the refusal is the real 409, and
// the change is the real capture → review → gate. The spec only watches and
// answers Basil; it never writes a run, a change or a budget row.
//
// WHY IT IS ONE TEST. Playwright records one video per test, so splitting the
// acts would produce clips of a story that only makes sense in order.
// `test.step` keeps the structure legible in the reporter without cutting the
// tape. Each act asserts its STORY beat against the UI and cross-checks the
// director's milestones at GET /api/__mock/state — never markup.
//
// Run it (see docs/demos/computer-lab-demo.md):
//   cd portal && DEMO_SLOW_MS=0 DEMO_BEAT_MS=250 npx playwright test --config playwright.demo.config.ts   # fast pass
//   cd portal && npx playwright test --config playwright.demo.config.ts                                  # the take

import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { signIn } from './realSession';

const INITIATIVE = 'Auth Migration';
/** The agents' names, as the director writes them onto their computers. */
const ADA = 'Ada';
const BASIL = 'Basil';
const CLEO = 'Cleo';
/** Ada's and Basil's items — the titles the review queue should carry. */
const ADA_ITEM = 'Logout leaves the legacy shim cookie alive';
const BASIL_ITEM = 'Tenant-by-tenant cutover runbook with rollback';
/** What Nora tells Basil, typed on camera. */
const ANSWER = 'Smallest tenant first — one tenant a day, so a bad cutover touches the fewest people.';

/** How long a beat holds on screen after it lands, so a viewer can read it. */
const BEAT_MS = Number(process.env['DEMO_BEAT_MS'] ?? 1800);
/** The director's beat (how fast the AGENTS move), sent in the scenario body.
 *  Defaults to ~2× the viewer's beat, clamped to 1–4s: the take tells the story
 *  at the director's own default, the fast pass in about a minute. */
const PACE_MS = Number(process.env['DEMO_PACE_MS'] ?? Math.min(4000, Math.max(1000, Math.round(BEAT_MS * 2.2))));

async function beat(page: Page, ms = BEAT_MS): Promise<void> {
  await page.waitForTimeout(ms);
}

/** Put every fixture back and stop any story in flight (docs/mock-floor.md). */
async function resetFixtures(request: APIRequestContext): Promise<void> {
  await request.post('/api/__mock/reset').catch(() => null);
}

interface DemoState {
  phase: string;
  milestones: Record<'running3' | 'questionAsked' | 'questionAnswered' | 'captured' | 'answerCaptured' | 'gateRefused', boolean>;
  answeredBy: 'person' | 'director' | null;
  gate: { gate?: string; confirmFlag?: string } | null;
  errors: string[];
}

async function demoState(request: APIRequestContext): Promise<DemoState> {
  // Tolerates one unreadable answer (a `tsx watch` reload mid-request) — the
  // poll that called it asks again; a reload that drops the story is caught by
  // the phase check in milestone().
  const res = await request.get('/api/__mock/state').catch(() => null);
  const body = res?.ok() ? await res.json().catch(() => null) as { demo?: DemoState } | null : null;
  return body?.demo ?? { phase: 'unreachable', milestones: {} as DemoState['milestones'], answeredBy: null, gate: null, errors: [] };
}

/** Wait for one of the director's milestones — the cross-check behind a beat. */
async function milestone(request: APIRequestContext, key: keyof DemoState['milestones'], timeout = 120_000): Promise<void> {
  await expect.poll(async () => {
    const s = await demoState(request);
    if (s.errors.length > 0) throw new Error(`demo director: ${s.errors.join('; ')}`);
    // `idle` mid-take means something reset the shared server (another
    // session's reset, or a middleware reload) and the story is gone.
    if (s.phase === 'idle') throw new Error('demo director is idle — the mock server was reset or restarted mid-take');
    return s.milestones[key];
  }, { message: `demo milestone ${key}`, timeout, intervals: [250, 500, 1000] }).toBe(true);
}

/** The lab pane showing a given agent's computer (its header carries the label). */
function paneOf(page: Page, agent: string): Locator {
  return page.getByTestId('lab-pane').filter({ has: page.locator(`[title^="${agent} · "]`) });
}

/** Switch a pane between Shell / Activity / Bot logs / Agent. */
async function showAs(page: Page, agent: string, kind: 'Shell' | 'Bot logs' | 'Agent'): Promise<void> {
  await paneOf(page, agent).getByRole('button', { name: 'Pane kind' }).click();
  await page.getByRole('menuitem').filter({ hasText: new RegExp(`^${kind}`) }).click();
}

/** The number on a status pill in the lab header ("3 running" → 3). */
async function pillCount(page: Page, status: string): Promise<number> {
  const pill = page.getByTestId(`lab-pill-${status}`);
  if (await pill.count() === 0) return 0;
  return Number(/\d+/.exec((await pill.textContent()) ?? '')?.[0] ?? 0);
}

test('computer lab walkthrough', async ({ page }) => {
  // A page that threw on camera is a re-take, not a footnote. 409 is
  // excluded because a money gate refusing a dispatch answers 409 by design;
  // the shell's GET /api/social/embedded probe is answered 403 for a session
  // without a social grant (every orgiq SME), counted by status AND url.
  const consoleErrors: string[] = [];
  let expectedSocialProbe403s = 0;
  page.on('response', (r) => {
    if (r.status() === 403 && new URL(r.url()).pathname === '/api/social/embedded') expectedSocialProbe403s += 1;
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (/status of 409/.test(m.text())) return;
    if (/status of 403/.test(m.text()) && expectedSocialProbe403s > 0) { expectedSocialProbe403s -= 1; return; }
    consoleErrors.push(m.text());
  });

  try {
    await test.step('Nora opens the Computer Lab', async () => {
      await page.goto('/');
      await resetFixtures(page.request);
      await page.goto('/');
      await signIn(page, 'u-nora');
      await page.goto('/admin/devbox');
      // The seeded fleet: computers grouped by the initiative they serve.
      await expect(page.getByTestId('lab-fleet-rail')).toBeVisible();
      await expect(page.getByTestId('lab-fleet-group').first()).toBeVisible();
      await beat(page);
    });

    await test.step('Three agents pick up three Auth Migration items', async () => {
      // Each pickup is a governed dispatch as Nora; `autoAnswer: false` means
      // only a person can answer Basil's question — the beat this take is for.
      const res = await page.request.post('/api/__mock/scenario', {
        data: { scenario: 'demo', paceMs: PACE_MS, autoAnswer: false },
      });
      expect(res.ok(), `starting the demo scenario answered ${res.status()}`).toBeTruthy();

      const group = page.getByTestId('lab-fleet-group').filter({ hasText: INITIATIVE });
      await expect(group).toContainText(/3 computers/, { timeout: 60_000 });
      for (const agent of [ADA, BASIL, CLEO]) {
        await expect(page.locator('[data-rail-row]', { hasText: agent }).first()).toBeVisible();
      }
      // The header pills count them at work (with any seeded box also running).
      await expect.poll(() => pillCount(page, 'running'), {
        message: 'three computers running at once', timeout: 60_000, intervals: [200],
      }).toBeGreaterThanOrEqual(3);
      await milestone(page.request, 'running3');
      await beat(page, BEAT_MS * 2);
    });

    await test.step("Inside Ada's microVM: a shell, then the agent's plan", async () => {
      await page.locator('[data-rail-row]', { hasText: ADA }).first().click();
      const ada = paneOf(page, ADA);
      await expect(ada).toBeVisible();
      // A real terminal on the computer. Click into it only — never toggle the
      // shell button, which would close a restored shell.
      const terminal = ada.locator('.xterm-helper-textarea');
      await expect(terminal).toHaveCount(1, { timeout: 15_000 });
      await terminal.click({ force: true });
      await page.keyboard.type('ls', { delay: 55 });
      await page.keyboard.press('Enter');
      await beat(page);

      // The Agent view: the run's latest plan as a checklist, step by step.
      await showAs(page, ADA, 'Agent');
      await expect(ada.getByText('Plan', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(ada.getByText(/\d+ of \d+ done/)).toBeVisible();
      await beat(page, BEAT_MS * 2);
    });

    await test.step("Cleo's bot logs stream", async () => {
      await page.getByRole('button', { name: new RegExp(`^Open ${CLEO} · .* in a new pane$`) }).click();
      await showAs(page, CLEO, 'Bot logs');
      // Log lines from Cleo's run on the refresh loop.
      await expect(paneOf(page, CLEO).getByText(/refresh/i).first()).toBeVisible({ timeout: 30_000 });
      await beat(page, BEAT_MS * 2);
    });

    await test.step('Cleo reaches for the next item, and the envelope gate holds it', async () => {
      await milestone(page.request, 'gateRefused');
      const gate = (await demoState(page.request)).gate;
      expect(gate?.gate).toBe('envelope');
      expect(gate?.confirmFlag).toBe('confirmOverEnvelope');

      await showAs(page, CLEO, 'Agent');
      const cleo = paneOf(page, CLEO);
      await expect(cleo.getByText(/Held at the envelope gate/)).toBeVisible({ timeout: 15_000 });
      await expect(cleo.getByText(/confirmOverEnvelope/).first()).toBeVisible();
      await beat(page, BEAT_MS * 3);
    });

    await test.step('Basil needs Nora — she answers from the lab', async () => {
      await milestone(page.request, 'questionAsked');
      await expect.poll(() => pillCount(page, 'waiting'), { message: 'a computer needs you', timeout: 30_000 })
        .toBeGreaterThanOrEqual(1);

      await page.getByRole('button', { name: new RegExp(`^Open ${BASIL} · .* in a new pane$`) }).click();
      await showAs(page, BASIL, 'Agent');
      const basil = paneOf(page, BASIL);
      await expect(basil.getByText(/Should I write it smallest-tenant-first or riskiest-tenant-first\?/).last())
        .toBeVisible({ timeout: 15_000 });
      await beat(page, BEAT_MS * 2);

      const reply = basil.getByRole('textbox', { name: /^Reply to Basil/ });
      await reply.click();
      await reply.pressSequentially(ANSWER, { delay: BEAT_MS >= 1000 ? 25 : 0 });
      await beat(page);
      await basil.getByRole('button', { name: 'Reply', exact: true }).click();

      // The answer resumed the task on Basil's session — the person did it.
      await milestone(page.request, 'questionAnswered', 30_000);
      expect((await demoState(page.request)).answeredBy).toBe('person');
      await expect(basil.getByText(ANSWER).first()).toBeVisible({ timeout: 15_000 });
      await beat(page, BEAT_MS * 2);
    });

    await test.step("Ada's change is posted for review; Basil finishes too", async () => {
      await milestone(page.request, 'captured');
      await expect(paneOf(page, ADA).getByText(/Change posted for review/)).toBeVisible({ timeout: 15_000 });
      await beat(page);
      await milestone(page.request, 'answerCaptured');
      await expect(paneOf(page, BASIL).getByText(/Change posted for review/)).toBeVisible({ timeout: 15_000 });
      await beat(page, BEAT_MS * 2);
    });

    await test.step('The changes wait in the review queue', async () => {
      // Reviewing is a different right: Helen Desai (u-hr, hr-admin) decides
      // what lands. Single-role, so no workspace picker detour.
      await page.goto('/');
      await signIn(page, 'u-hr');
      const queue = await page.request.get('/api/sdlc/changes');
      expect(queue.ok(), `review queue answered ${queue.status()}`).toBeTruthy();
      const titles = JSON.stringify(await queue.json());
      expect(titles).toContain(ADA_ITEM);
      expect(titles).toContain(BASIL_ITEM);

      await page.goto('/admin/changes');
      await expect(page.getByText(ADA_ITEM).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/delivering Auth Migration/i).first()).toBeVisible();
      await beat(page, BEAT_MS * 3);
    });

    expect(consoleErrors, `console errors during the walkthrough:\n${consoleErrors.join('\n')}`)
      .toHaveLength(0);
  } finally {
    await resetFixtures(page.request);
  }
});
