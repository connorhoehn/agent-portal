import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { BrowserContext, Page } from '@playwright/test';
import { test, expect } from './cdpTest';
import { signIn, type Principal } from './realSession';

test.use({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 900 } });
test.skip(process.env.ORIGINAL_DECK_RECOVERY_ACCEPTANCE !== '1' || !process.env.CDP_ENDPOINT,
  'Requires explicit original deck acceptance opt-in and authorized CDP');
const deckId = 'idk-42e8a3f0-0595-40d7-9afd-65f79cfaf843';
const head = 'irev-1f41698f-42ff-4052-8f21-0eb16834db1d';
const unavailable = 'Only this version’s saved metadata was preserved; its slide content is unavailable.';
const base = `/api/initiative-decks/${deckId}`;
const pageURL = `/iq/decks/${deckId}`;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const identity = ({ sub, tenant, role }: Principal) => ({ sub, tenant, role });
const oldFields = (revision: any) => ({ id: revision.id, label: revision.label,
  createdAt: revision.createdAt, producedBy: revision.producedBy });

test('original saved v7 is readable at the same URL with truthful historical versions, persistent questions and native PPTX', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const output = resolve(process.env.ORIGINAL_DECK_RECOVERY_EVIDENCE ?? info.outputDir);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'executed-test.ts'), await readFile(new URL(import.meta.url)));
  const save = (name: string, value: unknown) => writeFile(resolve(output, name), JSON.stringify(value, null, 2) + '\n');
  const archivePath = resolve('..', 'docs/demos/work-huddles/evidence/2026-10-09/original-v7-head-final.json');
  const archive = JSON.parse(await readFile(archivePath, 'utf8'));
  expect(archive.deckId).toBe(deckId); expect(archive.data.activeRevisionId).toBe(head);
  const actors: Array<{ context: BrowserContext; page: Page; principal: Principal;
    closed: boolean; requests: Array<{ method: string; path: string }>; errors: string[] }> = [];
  const receipts: any[] = [];
  let failure: string | null = null;
  try {
    for (const [userId, expectedRole] of [['u-nora', 'sme'], ['u-vera', 'member']] as const) {
      const context = await browser.newContext({ baseURL: 'http://localhost:5183', viewport: { width: 1440, height: 900 } });
      const requests: Array<{ method: string; path: string }> = [];
      context.on('request', request => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/api/')) requests.push({ method: request.method(), path });
      });
      let closed = false; context.on('close', () => { closed = true; });
      let principal: Principal;
      try { principal = await signIn(context, userId, { expectTenant: 'orgiq', expectRole: expectedRole }); }
      catch (error) { await context.close(); throw error; }
      let page: Page;
      try { page = await context.newPage(); } catch (error) { await context.close(); throw error; }
      const errors: string[] = [];
      const actor = { context, page, principal, get closed() { return closed; }, requests, errors }; actors.push(actor);
      page.on('pageerror', error => errors.push(error.message));
      const detailResponse = await context.request.get(base); expect(detailResponse.status()).toBe(200);
      const before = await detailResponse.json();
      expect(before.activeRevisionId).toBe(head);
      expect(before.revisions.map(oldFields)).toEqual(archive.data.revisions.map(oldFields));
      expect(before.revisions).toHaveLength(7);
      const specResponse = await context.request.get(`${base}/revisions/${head}/spec`); expect(specResponse.status()).toBe(200);
      const spec = await specResponse.json(); expect(spec).toEqual(archive.spec); expect(spec.slides).toHaveLength(6);
      const historical = [];
      for (const revision of before.revisions.filter((revision: any) => revision.id !== head)) {
        expect(revision.specAvailable).toBe(false); expect(revision.unavailabilityReason).toBe(unavailable);
        const response = await context.request.get(`${base}/revisions/${revision.id}/spec`);
        expect(response.status()).toBe(404);
        historical.push({ revisionId: revision.id, specStatus: response.status(), specAvailable: revision.specAvailable,
          unavailabilityReason: revision.unavailabilityReason });
      }
      await page.goto(pageURL);
      const mode = expectedRole === 'member' ? 'reader' : 'editor', prefix = `initiative-deck-${mode}`;
      await expect(page.getByTestId(prefix)).toBeVisible({ timeout: 30_000 });
      const stage = page.getByTestId(`${prefix}-stage`), image = stage.locator('img');
      await expect(image).toBeVisible(); await expect.poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
      const versions = page.getByRole('button', { name: 'Presentation versions', exact: true });
      await versions.click();
      const menu = page.getByRole('menu'); await expect(menu.getByRole('menuitem')).toHaveCount(7);
      const disabled = menu.locator('[role="menuitem"][aria-disabled="true"]'); await expect(disabled).toHaveCount(6);
      for (let index = 0; index < 6; index++) {
        await expect(disabled.nth(index)).toContainText('Slide content unavailable · Metadata only');
        await expect(disabled.nth(index).locator('[data-menu-disabled-reason]')).toBeVisible();
      }
      await page.screenshot({ path: resolve(output, `recovered-versions-${userId}.png`) });
      await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
      await page.getByTestId(mode === 'reader' ? `${prefix}-filmstrip-select-summary` : `${prefix}-slide-select-summary`).click();
      await expect(image).toHaveAttribute('alt', 'Observability: validation next');
      const dock = page.getByTestId('deck-composer-dock');
      const input = dock.getByRole('textbox', { name: 'Presentation message', exact: true });
      await expect(input).toBeEditable(); await expect(page.locator('[contenteditable="true"]')).toHaveCount(1);
      await page.getByRole('button', { name: 'Chat & agent', exact: true }).click(); await expect(input).toBeFocused();
      const draft = 'An unsent recovered-presentation question survives workspace resizing.';
      await input.fill(draft);
      const collapse = page.getByRole('button', { name: 'Collapse presentation assistant', exact: true });
      if (await collapse.isVisible()) await collapse.click();
      const measure = async () => ({ viewport: page.viewportSize(), stage: await stage.boundingBox(), composer: await dock.boundingBox(),
        input: await input.boundingBox(), currentURL: page.url() });
      const wide = await measure(); expect(wide.stage!.width).toBeGreaterThanOrEqual(320);
      expect(wide.composer!.y + wide.composer!.height).toBeLessThanOrEqual(901);
      await page.screenshot({ path: resolve(output, `recovered-${userId}-wide.png`) });
      await page.setViewportSize({ width: 1024, height: 768 }); await expect(input).toHaveText(draft);
      await expect(image).toBeVisible(); await expect(page.locator('[contenteditable="true"]')).toHaveCount(1);
      const narrow = await measure(); expect(narrow.stage!.width).toBeGreaterThanOrEqual(320);
      expect(narrow.composer!.y + narrow.composer!.height).toBeLessThanOrEqual(769);
      expect(narrow.input!.y + narrow.input!.height).toBeLessThanOrEqual(769);
      await page.screenshot({ path: resolve(output, `recovered-${userId}-narrow.png`) });
      await input.fill('');
      let question: any = { submitted: false };
      if (userId === 'u-vera') {
        const request = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === '/api/agents/orgiq-supervisor/invoke');
        const response = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/agents/orgiq-supervisor/invoke');
        await input.fill('Explain the next validation step for this saved slide without changing it.'); await input.press('Enter');
        const [sent, answer] = await Promise.all([request, response]), body = await answer.text();
        const captured = sent.postDataJSON();
        expect(captured.message).toContain(`Visible saved version: ${head}`);
        expect(captured.message).toContain('Scope: selected slide summary');
        expect(captured.message).toContain('Observability: validation next');
        expect(captured.selection).toEqual({ records: [{ type: 'initiative', id: 'p-observability' }] });
        await expect(page.getByTestId('deck-assistant-pane')).toBeVisible();
        await expect(page.getByTestId('initiative-agent-panel')).toBeVisible();
        expect(answer.status()).toBe(200);
        const completed = body.includes('RUN_FINISHED'), failed = body.includes('RUN_ERROR');
        expect(completed || failed, 'actual stream must expose its terminal outcome').toBe(true);
        question = { submitted: true, captured, status: answer.status(), outcome: completed ? 'completed' : 'failed',
          configuredRuntime: 'Actual configured BFF agent route; no model success assumed',
          visibleFeedback: await page.getByTestId('initiative-agent-panel').innerText() };
        await page.screenshot({ path: resolve(output, 'recovered-vera-question.png') });
      }
      expect(new URL(page.url()).pathname).toBe(pageURL);
      const assistantCollapse = page.getByRole('button', { name: 'Collapse presentation assistant', exact: true });
      if (await assistantCollapse.isVisible()) await assistantCollapse.click();
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30_000 }), page.getByTestId('initiative-deck-download').click({ timeout: 30_000 })]);
      const file = resolve(output, `recovered-v7-${userId}.pptx`); await download.saveAs(file);
      const pptx = JSON.parse(execFileSync('python3', ['-c', `import zipfile,json,re,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 slides=sorted(n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide[0-9]+\\.xml',n))
 text=' '.join(z.read(n).decode() for n in slides)
 notes=' '.join(z.read(n).decode() for n in z.namelist() if re.fullmatch(r'ppt/notesSlides/notesSlide[0-9]+\\.xml',n))
 print(json.dumps({'slides':len(slides),'sourcesPresent':'Sources' in text,'summaryTitlePresent':'Observability: validation next' in text,'savedSummaryNotePresent':'The validation checklist is ready for review.' in notes}))`, file], { encoding: 'utf8' }));
      expect(pptx).toEqual({ slides: 7, sourcesPresent: true, summaryTitlePresent: true, savedSummaryNotePresent: true });
      const afterResponse = await context.request.get(base); expect(afterResponse.status()).toBe(200);
      const after = await afterResponse.json(); expect(after).toEqual(before);
      const afterSpec = await (await context.request.get(`${base}/revisions/${head}/spec`)).json(); expect(afterSpec).toEqual(spec);
      const writes = requests.filter(request => request.method !== 'GET' && request.method !== 'OPTIONS');
      const unauthorizedWrites = writes.filter(request => request.path !== '/api/session/login'
        && request.path !== `${base}/preview` && request.path !== '/api/agents/orgiq-supervisor/invoke');
      expect(unauthorizedWrites).toEqual([]); expect(errors).toEqual([]);
      receipts.push({ principal: identity(principal), expectedHomeRole: expectedRole, originalDeckId: deckId, activeRevisionId: head,
        exactArchivedHeadSpec: true, specSHA256: sha(JSON.stringify(spec)), originalRevisionMetadataEqual: true,
        allSevenMetadataRowsPreserved: true, unavailableHistory: historical, versionsDisabledCount: 6,
        wide, narrow, onePersistentComposer: true, unsentDraftRetained: true, question,
        pptx: { ...pptx, file: `recovered-v7-${userId}.pptx`, sha256: sha(await readFile(file)), suggestedFilename: download.suggestedFilename() },
        headAndFullDetailUnchanged: true, documentWrites: [], observedNonGetRequests: writes, errors });
      await save(`recovered-${userId}-acceptance.json`, receipts[receipts.length - 1]);
    }
    await save('acceptance.json', { status: 'passed', observedAt: new Date().toISOString(), deckId, head,
      archiveEvidence: 'evidence/2026-10-09/original-v7-head-final.json', nativeRoutesMocked: false,
      roleOrTenantSwitches: false, resetOrDocumentWrites: false, huddleOrMediaStarted: false,
      questionOutcome: receipts.find(actor => actor.principal.sub === 'u-vera')?.question.outcome, actors: receipts });
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    await save('incomplete.json', { status: 'incomplete', failure, completedActors: receipts,
      actorBaselines: actors.map(actor => identity(actor.principal)) });
    await Promise.all(actors.map(actor => actor.page.screenshot({ path: resolve(output, `incomplete-${actor.principal.sub}.png`) }).catch(() => undefined)));
    throw error;
  } finally {
    await Promise.all(actors.map(actor => actor.context.close()));
    await save('owned-context-cleanup.json', { failure, contexts: actors.map(actor => ({ principal: identity(actor.principal),
      contextClosedEvent: actor.closed, pageClosed: actor.page.isClosed(), remainingPages: actor.context.pages().length })) });
  }
});
