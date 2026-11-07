import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import adapter from './ui-dom-audit.adapter';
// The shared engine runs in the browser; this fixture binds the actual portal selector.
// @ts-expect-error The portable audit intentionally ships plain JavaScript.
import { measureDOM } from './lib/ui-dom-audit/measure.mjs';

test('adjustable and ordinary workspace frames retain column checks', async ({ page }) => {
  const contract = JSON.parse(readFileSync(new URL('./lib/ui-dom-audit/work-ui.contract.json', import.meta.url), 'utf8'));
  const rules = contract.rules.filter((rule: { id: string }) => ['workspace.columns', 'workspace.resizable-columns'].includes(rule.id));
  const payload = { contract: { ...contract, rules }, selectors: adapter.selectors };
  const measure = () => page.evaluate(measureDOM, payload) as Promise<{ issues: { rule: string }[] }>;
  for (const adjustable of [false, true]) {
    const columns = '<aside data-testid="fixture-primary" style="width:264px">Items</aside><main data-testid="fixture-secondary" style="flex:1">Document</main>';
    await page.setContent(`<div data-testid="explorer-layout" style="display:flex;width:900px;height:600px">${adjustable ? `<div data-testid="explorer-layout-rail-split" style="display:flex;width:100%;height:100%">${columns}<div role="separator" style="position:absolute;left:260px;width:8px;height:600px"></div></div>` : columns}</div>`);
    expect((await measure()).issues).toEqual([]);
    await page.locator('main').evaluate(el => { el.style.marginLeft = '20px'; });
    expect((await measure()).issues.some(issue => issue.rule === (adjustable ? 'workspace.resizable-columns' : 'workspace.columns'))).toBe(true);
  }
});
