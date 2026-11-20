import { expect, test } from '@playwright/test';
import { loginAs } from './realSession';

const BASE = process.env.PARITY_BASE_URL ?? 'http://127.0.0.1:5183';
const QUOTE = "Checking every pair would take quadratic time. Instead, I'll keep a dictionary of numbers I've already seen with their indices. For each number I look up the target minus that number. I check before storing the current index.";

for (const state of ['draft', 'submitted']) for (const width of [1280, 900]) for (const theme of ['light', 'dark'] as const) {
  test(`${state}: expanded source quotes wrap without clipping at ${width}px in ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({ baseURL: BASE, viewport: { width, height: 800 }, colorScheme: theme });
    try {
      const interview = state === 'draft' ? 'iv-g9r1y8lp' : 'iv-d7q4n9xe';
      await loginAs(context, state === 'draft' ? 'u-wen' : 'u-hugo', BASE);
      expect((await context.request.post('/api/session/tenant', { data: { tenant: 'interviews' } })).status()).toBe(200);
      const page = await context.newPage();
      await page.route(`**/api/interviews/interviews/${interview}/recap**`, async (route) => {
        // Local response fixture: opening the preview writes no ratings or model request to the server.
        const recap = { state: 'ready', paused: null, writtenAt: '2026-11-20T22:00:00Z',
          competencies: [{ id: 'communication', name: 'Communication', evidence: [
            { text: 'The candidate said this.', source: { kind: 'transcript', seq: 13, quote: QUOTE } },
          ] }], notCovered: [] };
        await route.fulfill({ json: { recap } });
      });
      await page.goto(`/interviews/rounds/${interview}/scorecard`);
      if (state === 'draft') {
        const ratings = page.locator('[data-ui-control="rating"]');
        await ratings.first().waitFor();
        for (let i = 0; i < await ratings.count(); i += 1) await ratings.nth(i).getByRole('radio', { name: /^3 / }).click();
        await page.getByTestId('interviews-scorecard-to-recap').click();
        await page.getByTestId('interviews-scorecard-ask-option-open').click();
      }
      await page.evaluate((value) => { document.documentElement.classList.toggle('dark', value === 'dark'); document.documentElement.dataset.theme = value; }, theme);
      const evidence = page.getByTestId('interviews-recap-evidence').first();
      await evidence.getByText(/Milo.s evidence/).first().click();
      await page.getByTestId('interviews-recap-claim').first().click();
      const quote = page.getByTestId('interviews-recap-full-quote').first();
      await expect(quote).toBeVisible();
      await expect(quote).toHaveText(`“${QUOTE}”`);
      const measured = await quote.evaluate((element) => {
        const range = document.createRange(); range.selectNodeContents(element);
        const rects = [...range.getClientRects()];
        const box = element.getBoundingClientRect();
        return { whiteSpace: getComputedStyle(element).whiteSpace, lines: new Set(rects.map((r) => Math.round(r.top))).size,
          ancestors: [...(function* () { let e: Element | null = element; while (e) { yield { tag: e.tagName, classes: e.className, whiteSpace: getComputedStyle(e).whiteSpace }; e = e.parentElement; } })()],
          contentRight: Math.max(...rects.map((r) => r.right)), boxRight: box.right,
          contentLeft: Math.min(...rects.map((r) => r.left)), boxLeft: box.left };
      });
      test.info().annotations.push({ type: 'geometry', description: JSON.stringify(measured) });
      expect(measured.whiteSpace).not.toBe('nowrap');
      expect(measured.lines).toBeGreaterThan(1);
      expect(measured.contentRight).toBeLessThanOrEqual(measured.boxRight + 1);
      expect(measured.contentLeft).toBeGreaterThanOrEqual(measured.boxLeft - 1);
    } finally { await context.close(); }
  });
}
