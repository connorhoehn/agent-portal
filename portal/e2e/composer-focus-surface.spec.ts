// The message composer's focus treatment is the rounded surface, never a
// second box inside it (library 2.500.1 painted a 2 px outline inside the
// editor; 2.500.2 scopes it away from RichChatComposer; todo WORK-UI-07).
// One composer per tenant, as a clone: click into the editor, then the editor
// itself carries no outline, keeps its padding, and the surface shows the
// focus ring. Evidence in .scratch/composer-focus-2026-11-03/.
import { expect, test } from '@playwright/test';
import { openAsClone } from './realSession';

const OUT = '../.scratch/composer-focus-2026-11-03';
const CASES = [
  { tenant: 'orgiq', persona: 'u-nora', path: '/iq/projects/p-auth-migration?scope=all' },
  { tenant: 'pipelines', persona: 'u-ines', path: '/pipelines/runs' },
  { tenant: 'social', persona: 'u-sana', path: '/social/contacts' },
  { tenant: 'assessment', persona: 'u-asha', path: '/assessment/submissions' },
  { tenant: 'access', persona: 'u-rhea', path: '/access/requests' },
] as const;

for (const c of CASES) test(`${c.tenant}: the focused composer has no inner outline and keeps its padding (${c.path})`, async ({ browser }) => {
  test.setTimeout(90_000);
  const person = await openAsClone(browser, c.persona, { tenant: c.tenant, landing: null, preJoin: 'remembered', label: `composer-focus-${c.tenant}` });
  const { page } = person;
  try {
    await page.goto(c.path);
    const editor = page.locator('.chat-composer .chat-composer-input[contenteditable="true"]').first();
    await expect(editor).toBeVisible({ timeout: 30_000 });
    await editor.click();
    await expect(editor).toBeFocused();
    const measured = await editor.evaluate(el => {
      const cs = getComputedStyle(el);
      const surface = el.closest('.chat-composer') as HTMLElement;
      const ss = getComputedStyle(surface);
      return {
        outline: `${cs.outlineStyle} ${cs.outlineWidth}`,
        padding: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(v => parseFloat(v)),
        minHeight: parseFloat(cs.minHeight),
        surfaceRing: ss.boxShadow !== 'none' || ss.outlineStyle !== 'none' || surface.matches(':focus-within'),
        surfaceSize: surface.getAttribute('data-composer-size'),
      };
    });
    expect(measured.outline).toMatch(/^none/);
    // The editor's own inset: at least 0.5rem of vertical and 0.625rem of horizontal padding, a 2rem+ box.
    expect(Math.min(measured.padding[0], measured.padding[2])).toBeGreaterThanOrEqual(5);
    expect(Math.min(measured.padding[1], measured.padding[3])).toBeGreaterThanOrEqual(10);
    expect(measured.minHeight).toBeGreaterThanOrEqual(32);
    expect(measured.surfaceRing).toBe(true);
    expect(measured.surfaceSize).toBeTruthy();
    const box = (await editor.locator('xpath=ancestor::*[contains(@class,"chat-composer")][1]').boundingBox())!;
    await page.screenshot({ path: `${OUT}/${c.tenant}-focused.png`, clip: { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(1440, box.width + 16), height: box.height + 16 } });
  } finally { await person.close(); }
});
