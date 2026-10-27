// The document workspace on the DEPLOYED stack: an assessment user opens a
// knowledge page, the BFF grants a canvas on the document gateway, and the
// browser's socket to wss://<portal>/document-realtime opens through
// CloudFront. Skipped unless CLOUD_PORTAL_URL and CLOUD_LOGIN_DOC
// (<email>:<password>, an assessment ManageKnowledge role) are set.
import { test, expect } from '@playwright/test';
import { cloudBase, cloudSignIn, cloudUseTenant } from './cloudSession';

const login = process.env.CLOUD_LOGIN_DOC;
test.skip(!cloudBase || !login, 'CLOUD_PORTAL_URL / CLOUD_LOGIN_DOC not set');

test('an assessment page opens a live canvas on the deployed document gateway', async ({ browser }) => {
  test.setTimeout(120000);
  const sockets: string[] = [];
  const page = await cloudSignIn(browser, login!, 'doc', (p) => { p.on('websocket', (ws) => sockets.push(ws.url())); });
  await cloudUseTenant(page, 'assessment');

  const tree = await page.request.get('/api/assessment/knowledge/tree');
  expect(tree.status(), await tree.text()).toBe(200);
  const ids: string[] = [];
  const walk = (n: any) => { if (n?.id && /^(page|draft):/.test(n.id)) ids.push(n.id); for (const c of n?.children ?? []) walk(c); };
  const body = await tree.json();
  for (const n of Array.isArray(body) ? body : body.tree ?? body.nodes ?? []) walk(n);
  if (ids.length === 0) {
    // A fresh deploy has no knowledge source: make the page the canvas opens.
    const created = await page.request.post('/api/assessment/knowledge/doc/create',
      { data: { title: 'Cloud document smoke', sectionKey: 'workspace_drafts', markdown: '# Cloud document smoke\n\nOpened through the deployed gateway.' } });
    expect(created.status(), await created.text()).toBe(201);
    ids.push((await created.json()).id);
  }

  const grant = await page.request.post('/api/assessment/knowledge/canvas', { data: { id: ids[0] } });
  expect(grant.status(), await grant.text()).toBe(200);
  const { gatewayUrl } = await grant.json();
  expect(gatewayUrl).toBe(`${cloudBase!.replace(/^https:/, 'wss:')}/document-realtime`);

  await page.goto(`/assessment/workspace?doc=${encodeURIComponent(ids[0])}`);
  await expect(page.getByTestId('document-shell')).toBeVisible({ timeout: 30000 });
  await expect.poll(() => sockets.some((u) => u.includes('/document-realtime')), { timeout: 30000 }).toBe(true);
  await page.screenshot({ path: test.info().outputPath('document.png'), fullPage: true });
});
