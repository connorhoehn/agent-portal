import { test, expect } from '@playwright/test';
import adapter, { settled } from './ui-dom-audit.adapter';

test('readiness ignores a closed lazy disclosure but still waits for visible loading', async ({ page }) => {
  test.setTimeout(25000);
  const spec = { tenant: 'orgiq' as const, path: '/iq/projects/example', source: 'param' as const, kind: 'record' as const };
  await page.route('**/iq/projects/example', route => route.fulfill({ contentType: 'text/html', body: '<html data-tenant="orgiq"><header class="shell-header">Work</header><h1>Example</h1><details><summary>Preview</summary><div data-testid="loading-state">Loading preview</div></details></html>' }));
  await page.goto(spec.path);
  await adapter.ready(page, spec);
  await page.getByText('Preview', { exact: true }).click();
  await expect(adapter.ready(page, spec)).rejects.toThrow();
});

test('row navigation waits for the lazy runbook record beyond the URL change', async ({ page }) => {
  await page.route('**/iq/runbooks/example', route => route.fulfill({ contentType: 'text/html', body: '<html><header>Work</header><main></main></html>' }));
  await page.goto('/iq/runbooks/example');
  await page.evaluate(() => {
    setTimeout(() => { document.querySelector('main')!.innerHTML = '<div data-testid="loading-state">Loading page…</div>'; }, 50);
    setTimeout(() => { document.querySelector('main')!.innerHTML = '<section data-testid="runbook-record"><h1>Example</h1></section>'; }, 250);
  });
  await settled(page);
  await expect(page.getByTestId('runbook-record')).toBeVisible();
});

for (const body of [
  '<section data-testid="pipelines-configuration-details"><h2>Default approver</h2><p>Operator</p></section>',
  '<div data-testid="error-state">Configuration unavailable. Try again.</div>',
]) test(`configuration readiness accepts its rendered ${body.includes('error-state') ? 'error' : 'read-only details'} state`, async ({ page }) => {
  const spec = { tenant: 'pipelines' as const, path: '/pipelines/configuration', source: 'static' as const, kind: 'page' as const };
  await page.route('**/pipelines/configuration', route => route.fulfill({ contentType: 'text/html', body: `<html data-tenant="pipelines"><header class="shell-header">Work</header><main data-testid="pipelines-configuration"><h1>Configuration</h1>${body}</main></html>` }));
  await page.goto(spec.path);
  await adapter.ready(page, spec);
});

for (const body of [
  '<div data-ui-empty>No contacts yet</div>',
  '<div data-testid="error-state">Contacts unavailable. Try again.</div>',
]) test(`collection readiness accepts a settled ${body.includes('error-state') ? 'error' : 'empty'} result without a table`, async ({ page }) => {
  const spec = { tenant: 'social' as const, path: '/social/contacts', source: 'static' as const, kind: 'page' as const, judges: ['table' as const] };
  await page.route('**/social/contacts', route => route.fulfill({ contentType: 'text/html', body: `<html data-tenant="social"><header class="shell-header">Social</header><main data-collection-page>${body}</main></html>` }));
  await page.goto(spec.path);
  await adapter.ready(page, spec);
});
