import { test, expect } from './cdpTest';
import { signIn } from './realSession';
import { writeFile } from 'node:fs/promises';

test.use({ viewport: { width: 1440, height: 960 }, actionTimeout: 5_000, navigationTimeout: 15_000 });

test('native Assessment files reads, document breadcrumb and legacy deck routes remain available', async ({ page }) => {
  const errors: string[] = [], mutations: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await signIn(page, 'u-asha', { expectTenant: 'assessment', expectRole: 'assessor' });
  page.on('request', request => {
    if (request.method() !== 'GET' && /\/api\/assessment\/.*(?:decks|knowledge\/doc\/(?:create|rename|move|restore))/.test(request.url())) mutations.push(request.url());
  });
  const decksResponse = await page.request.get('/api/assessment/decks');
  const teamResponse = await page.request.get('/api/assessment/decks?teamId=TEAM-001');
  const treeResponse = await page.request.get('/api/assessment/knowledge/tree');
  expect(decksResponse.status()).toBe(200); expect(teamResponse.status()).toBe(200); expect(treeResponse.status()).toBe(200);
  const decks = await decksResponse.json(), teamDecks = await teamResponse.json(), tree = await treeResponse.json();
  expect(teamDecks.every((deck: { teamId: string }) => deck.teamId === 'TEAM-001')).toBe(true);
  await page.goto('/assessment/workspace?doc=page%3A100002');
  const trail = page.getByTestId('knowledge-trail');
  await expect(trail).toContainText('Rubric Overview');
  await expect(trail).toContainText('Workspace');
  await expect(trail).not.toContainText('Informatics');
  await expect(trail).not.toContainText('Documents');
  await expect(page.locator('a[href="/assessment/decks"]')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('native-workspace-breadcrumb.png') });
  await page.goto('/assessment/workspace?view=library');
  const list = page.getByTestId('document-result-list');
  await expect(list).toContainText('Rubric Overview');
  for (const deck of decks) await expect(list).toContainText(deck.title);
  await page.screenshot({ path: test.info().outputPath('native-workspace-files.png') });
  await page.goto('/assessment/teams/TEAM-001?tab=documents');
  await expect(page.getByTestId('document-list-page')).toBeVisible();
  await expect(page.getByTestId('document-result-list')).toContainText('Rubric Overview');
  await expect(page.getByText(/and shared Workspace documents\./)).toBeVisible();
  for (const deck of teamDecks) await expect(page.getByTestId('document-result-list')).toContainText(deck.title);
  await page.screenshot({ path: test.info().outputPath('native-team-files.png') });
  await page.getByTestId('document-result-list').getByText('Rubric Overview', { exact: true }).click();
  await expect(page).toHaveURL(/\/assessment\/workspace\?doc=page%3A100002$/);
  await page.goto('/assessment/decks');
  await expect(page.getByRole('heading', { name: 'Review decks' })).toBeVisible();
  expect(mutations).toEqual([]); expect(errors).toEqual([]);
  const proof = JSON.stringify({
    scope: 'Real picker Asha home Assessment; native list, tree and legacy route; no record writes',
    nativeDeckCount: decks.length, nativeTeamDeckCount: teamDecks.length, nativeWorkspaceSections: tree.sections.map((section: { key: string }) => section.key),
    nativeDecks: decks.map((deck: { id: string; teamId: string; title: string; latestRevision: unknown }) => deck), mutations, errors,
  }, null, 2);
  await writeFile(test.info().outputPath('native-files-proof.json'), proof);
  await test.info().attach('native-files-proof.json', { contentType: 'application/json', body: Buffer.from(proof) });
});

test('saved presentation metadata participates in the shared files list, team scope and type filter; failures stay visible', async ({ page }) => {
  const fixtureDecks = [
    { id: 'deck-discovery-fixture', teamId: 'TEAM-001', title: 'Northstar presentation fixture', updatedAt: '2026-10-09T14:00:00Z', latestRevision: { id: 'revision-fixture', label: 'v7', createdAt: '2026-10-09T14:00:00Z', producedBy: 'fixture' } },
    { id: 'deck-other-fixture', teamId: 'TEAM-002', title: 'Another team presentation fixture', updatedAt: '2026-10-09T13:00:00Z', latestRevision: null },
  ];
  let failDecks = false;
  await page.goto('/'); await signIn(page, 'u-asha', { expectTenant: 'assessment', expectRole: 'assessor' });
  await page.route('**/api/assessment/decks?*', route => {
    const team = new URL(route.request().url()).searchParams.get('teamId');
    return route.fulfill(failDecks ? { status: 503, json: { error: 'Presentation list temporarily unavailable' } }
      : { json: fixtureDecks.filter(deck => !team || deck.teamId === team) });
  });
  await page.route('**/api/assessment/decks', route => route.fulfill(failDecks
    ? { status: 503, json: { error: 'Presentation list temporarily unavailable' } } : { json: fixtureDecks }));
  await page.goto('/assessment/workspace?view=library');
  const list = page.getByTestId('document-result-list');
  await expect(list).toContainText('Rubric Overview'); await expect(list).toContainText('Northstar presentation fixture');
  await expect(list).toContainText('PowerPoint · v7');
  await page.getByRole('button', { name: 'Filter documents', exact: true }).click();
  await page.getByRole('button', { name: 'Presentation', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(list).toContainText('Northstar presentation fixture'); await expect(list).not.toContainText('Rubric Overview');
  await page.screenshot({ path: test.info().outputPath('fixture-workspace-presentations.png') });
  await list.getByText('Northstar presentation fixture', { exact: true }).click();
  await expect(page).toHaveURL(/\/assessment\/decks\/deck-discovery-fixture$/);
  await page.goto('/assessment/teams/TEAM-001?tab=documents');
  await expect(list).toContainText('Northstar presentation fixture'); await expect(list).not.toContainText('Another team presentation fixture');
  await expect(list).toContainText('Rubric Overview');
  await page.screenshot({ path: test.info().outputPath('fixture-team-presentations-and-documents.png') });
  failDecks = true;
  await page.goto('/assessment/workspace?view=library');
  await expect(page.getByText(/Presentations are unavailable: 503/)).toBeVisible();
  await expect(list).toContainText('Rubric Overview');
  failDecks = false; await page.getByRole('button', { name: 'Retry presentations' }).click();
  await expect(list).toContainText('Northstar presentation fixture');
  await expect(page.getByText(/Presentations are unavailable:/)).toHaveCount(0);
});
