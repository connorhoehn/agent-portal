import { expect, test, type Page } from '@playwright/test';
import { signIn } from './realSession';
import type { KnowledgeTreeResponse } from '../src/pages/assessment/knowledge/types';
import { chooseOption } from './selectOption';

// Exercise the real frame/permissions. Tree moves are confined to this browser
// fixture: these checks never reorder the shared Confluence mock or publish content.
async function workspace(page: Page) {
  await page.goto('/');
  await signIn(page, 'u-farah', { expectTenant: 'assessment', expectRole: 'lead-assessor' });
  let tree: KnowledgeTreeResponse | undefined;
  const moves: Array<{ id: string; parentId: string; position: number }> = [];
  let refuseMove = false;
  await page.route('**/api/assessment/knowledge/tree', async route => {
    tree ??= await (await route.fetch()).json() as KnowledgeTreeResponse;
    return route.fulfill({ json: { ...tree, sourceConfigured: true } });
  });
  await page.route('**/api/assessment/knowledge/source/move', async route => {
    const input = route.request().postDataJSON() as typeof moves[number];
    if (refuseMove) return route.fulfill({ status: 409, json: { error: 'The source refused this move.' } });
    moves.push(input);
    const nodes = tree!.sections.flatMap(section => section.nodes);
    const node = nodes.find(node => node.id === input.id)!;
    node.parent_id = input.parentId;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto('/assessment/workspace?doc=page%3A100002');
  await expect(page.getByTestId('document-rail-tree-row-page:100002')).toBeVisible();
  return { moves, refuse: () => { refuseMove = true; } };
}

test.use({ viewport: { width: 1440, height: 960 } });

test('sidebar resizes, remembers width and folds without remounting the document', async ({ page }) => {
  await workspace(page);
  const rail = page.getByTestId('knowledge-explorer-rail');
  const divider = page.getByRole('separator', { name: 'Resize document sidebar' });
  const initial = (await rail.boundingBox())!.width;
  await divider.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeGreaterThan(initial + 10);
  const handle = (await divider.boundingBox())!;
  const beforeDrag = (await rail.boundingBox())!.width;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 70, handle.y + 100, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await rail.boundingBox())!.width).toBeGreaterThan(beforeDrag + 50);
  const saved = (await rail.boundingBox())!.width;
  const pane = page.getByTestId('knowledge-explorer-pane');
  const originalPane = await pane.elementHandle();
  await page.getByTestId('knowledge-explorer-rail-fold').click();
  await expect(rail).toHaveAttribute('data-collapsed', 'true');
  expect(await pane.evaluate((element, original) => element === original, originalPane)).toBe(true);
  await page.getByRole('button', { name: 'Show document library' }).click();
  await expect.poll(async () => Math.abs((await rail.boundingBox())!.width - saved)).toBeLessThan(2);
  await page.reload();
  await expect.poll(async () => Math.abs((await rail.boundingBox())!.width - saved)).toBeLessThan(2);
});

test('readers can share an existing-access link but cannot move or drag documents', async ({ page }) => {
  await page.goto('/');
  await signIn(page, 'u-jonas', { expectTenant: 'assessment', expectRole: 'assessor' });
  await page.goto('/assessment/workspace?doc=page%3A100002');
  const row = page.getByTestId('document-rail-tree-row-page:100002');
  await expect(row).toBeVisible();
  await expect(row).not.toHaveAttribute('draggable', 'true');
  await page.getByTestId('document-rail-tree-row-page:100002-menu-trigger').click();
  await expect(page.getByRole('menuitem', { name: 'Share…', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Move to…', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Rename…', exact: true })).toHaveCount(0);
});

test('leaf and parent siblings align, active and hovered menus open sharing and move', async ({ page }) => {
  const { moves } = await workspace(page);
  const leaf = page.getByTestId('document-rail-tree-row-page:100002');
  const folder = page.getByTestId('document-rail-tree-row-page:100003');
  const labelEdge = (row: ReturnType<Page['getByTestId']>) => row.locator('span[title]').evaluate(element => element.getBoundingClientRect().left);
  expect(Math.abs(await labelEdge(leaf) - await labelEdge(folder))).toBeLessThan(1);
  const activeMenu = page.getByTestId('document-rail-tree-row-page:100002-menu-trigger');
  await expect(activeMenu).toBeVisible();
  await activeMenu.click();
  await page.getByRole('menuitem', { name: 'Share…', exact: true }).click();
  await expect(page.getByTestId('share-document-dialog')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Document link' })).toHaveValue(/doc=page%3A100002/);
  await expect(page.getByText('Copying this link keeps the current permissions.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await folder.hover();
  await expect(page.getByTestId('document-rail-tree-row-page:100003-menu-trigger')).toBeVisible();
  await leaf.hover();
  await activeMenu.click();
  await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
  await chooseOption(page.getByLabel('Move destination', { exact: true }), 'page:100003');
  await page.getByRole('button', { name: 'Move here', exact: true }).click();
  await expect(page.getByTestId('move-document-dialog')).toHaveCount(0);
  expect(moves).toEqual([{ id: 'page:100002', parentId: 'page:100003', position: 1 }]);
  await expect(page.getByTestId('document-rail-tree-row-page:100003-children').getByTestId('document-rail-tree-row-page:100002')).toBeVisible();
  await page.screenshot({ path: '../docs/design/documents-parity/sidebar-resize-hierarchy.png' });
});

test('a refused move stays open and a drag nests through the same persisted path', async ({ page }) => {
  const state = await workspace(page);
  const leaf = page.getByTestId('document-rail-tree-row-page:100002');
  const target = page.getByTestId('document-rail-tree-row-page:100003');
  // Native HTML dragging; crossing text spans must not clear the drop target.
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await leaf.dispatchEvent('dragstart', { dataTransfer });
  const box = (await target.boundingBox())!;
  await target.dispatchEvent('dragover', { dataTransfer, clientY: box.y + box.height / 2 });
  await expect(target).toHaveAttribute('data-drop', 'into');
  await target.dispatchEvent('drop', { dataTransfer, clientY: box.y + box.height / 2 });
  await expect.poll(() => state.moves.length).toBe(1);
  await expect(page.getByTestId('document-rail-tree-row-page:100003-children').getByTestId('document-rail-tree-row-page:100002')).toBeVisible();
  state.refuse();
  await page.getByTestId('document-rail-tree-row-page:100002-menu-trigger').click();
  await page.getByRole('menuitem', { name: 'Move to…', exact: true }).click();
  await chooseOption(page.getByLabel('Move destination', { exact: true }), 'page:100001');
  await page.getByRole('button', { name: 'Move here', exact: true }).click();
  await expect(page.getByTestId('move-document-dialog')).toBeVisible();
  await expect(page.getByTestId('move-document-dialog')).toContainText('The source refused this move.');
  expect(state.moves).toHaveLength(1);
});
