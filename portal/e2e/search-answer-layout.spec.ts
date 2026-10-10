import { test, expect } from '@playwright/test';
import { loginAs } from './realSession';

// The Answer tab's rows share one left edge: prose, evidence, sources,
// footnote chips and the reaction row (search-workspace follow-up, 2026-10-07).
test.beforeEach(async ({ context, baseURL }) => { await loginAs(context, 'u-theo', baseURL); });

test('every row of the answer message shares one left edge', async ({ page }) => {
  await page.goto('/iq/search?scope=p-llm-platform&type=person&tab=answer');
  const input = page.getByRole('textbox', { name: /search question/i }).first();
  await input.click();
  await page.keyboard.type('k.kl');
  await page.keyboard.press('Enter');
  await page.getByTestId('search-evidence').waitFor({ timeout: 30_000 });
  // Left edges, in CSS px, of the rows of the last answer message.
  const edges = await page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement;
    const msg = Array.from(log.children).filter(c => c.querySelector('[data-testid="markdown-view"]')).at(-1) as HTMLElement;
    const left = (el: Element | null | undefined) => el ? el.getBoundingClientRect().left : NaN;
    const prose = msg.querySelector('[data-testid="markdown-view"]');
    const heading = (name: string) => Array.from(log.querySelectorAll('h4')).find(h => h.textContent?.trim() === name);
    return {
      container: left(msg),
      prose: left(prose?.firstElementChild ?? prose),
      work: left(heading('Work to coordinate')),
      sources: left(heading('Sources')),
      graphCard: left(log.querySelector('[data-testid="search-graph-card"]')),
      footnotes: left(log.querySelector('[aria-label="Sources"]')),
      reactions: left(log.querySelector('button[aria-label="Good answer"]')),
    };
  });
  console.log(JSON.stringify(edges));
  // Nothing in the evidence card (status / citation column) clips past its right edge.
  const clipped = await page.evaluate(() => {
    const ev = document.querySelector('[data-testid="search-evidence"]') as HTMLElement;
    const right = ev.getBoundingClientRect().right;
    return Array.from(ev.querySelectorAll('*')).filter(e => e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().right > right + 1).map(e => e.tagName + ':' + (e.textContent ?? '').slice(0, 20));
  });
  expect(clipped).toEqual([]);
  for (const [name, value] of Object.entries(edges)) {
    expect(Number.isFinite(value), name).toBe(true);
    expect(value, `${name} sits left of the message container`).toBeGreaterThanOrEqual(edges.container - 1);
    expect(Math.abs(value - edges.prose), `${name} shares the prose edge`).toBeLessThanOrEqual(1);
  }
});
