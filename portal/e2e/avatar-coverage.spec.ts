import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { openAsClone } from './realSession';
import { staticInventory, PARAM_ROUTES, resolveParam } from './route-inventory';

// The names identify audit candidates, never supply runtime portraits. A UI
// must retain its authorized person's ID and URL, not guess from this cast.
const cast = JSON.parse(fs.readFileSync(new URL('../src/lib/demoPortraits.json', import.meta.url), 'utf8')).personas as Array<{ name: string; portraitUrl: string }>;

test('named people retain loaded portraits across people-bearing routes', async ({ browser }) => {
  test.setTimeout(300_000);
  const report: Array<{ route: string; people: Array<{ name: string; src: string | null; loaded: boolean; known: boolean }> }> = [];
  for (const tenant of ['orgiq', 'assessment', 'social', 'pipelines'] as const) {
    const person = await openAsClone(browser, 'u-operator', { tenant, viewport: { width: 1440, height: 1000 }, landing: null });
    try {
      const paths = staticInventory().filter(r => r.tenant === tenant && /projects|decisions|designs|search|explore|scores|teams|contacts|channels|communication|identity\/users/.test(r.path)).map(r => r.path);
      for (const r of PARAM_ROUTES.filter(r => r.tenant === tenant && /projects|decisions|designs|teams|channels/.test(r.pattern))) {
        paths.push(await resolveParam(r, async url => (await person.page.request.get(url)).json()));
      }
      if (tenant === 'orgiq') {
        paths.push('/iq/projects?scope=all', '/iq/projects?lens=sprints');
        const projects = await (await person.page.request.get('/api/graph/projects?limit=200&scope=all')).json();
        for (const project of projects) for (const tab of ['overview', 'work', 'contributors']) paths.push(`/iq/projects/${encodeURIComponent(project.id)}?scope=all&tab=${tab}`);
        const { reviews } = await (await person.page.request.get('/api/designs')).json();
        for (const review of reviews) paths.push(`/iq/designs/${encodeURIComponent(review.id)}`);
      }
      const writes: string[] = [];
      await person.page.route('**/api/**', route => {
        if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.continue();
        writes.push(route.request().url()); return route.abort();
      });
      // Recheck an affected inventory route after a local server restart without
      // inventing routes or repeating every tenant. No match still fails below.
      const selectedPaths = [...new Set(paths)].filter(path => !process.env.AVATAR_AUDIT_PATH || path.includes(process.env.AVATAR_AUDIT_PATH));
      for (const route of selectedPaths) {
        await person.page.goto(route);
        await person.page.locator('main').first().waitFor();
        await person.page.waitForTimeout(700);
        const people = await person.page.locator('[data-ui-text="avatar"]:visible').evaluateAll((els, names) => els.flatMap(el => {
          const img = el.querySelector('img');
          const name = el.getAttribute('title') || img?.alt || '';
          if (!name || /^\+\d/.test(name)) return [];
          return [{ name, src: img?.getAttribute('src') ?? null, loaded: !!img && img.complete && img.naturalWidth > 0, known: names.includes(name) }];
        }), cast.map(person => person.name));
        report.push({ route, people });
        if (people.some(person => !person.loaded)) await person.page.screenshot({ path: test.info().outputPath(`${tenant}-${report.length}.png`) });
      }
      expect(writes, `${tenant}: read-only audit`).toEqual([]);
    } finally { await person.close(); }
  }
  await test.info().attach('portrait-coverage', { body: JSON.stringify(report, null, 2), contentType: 'application/json' });
  fs.writeFileSync(test.info().outputPath('portrait-coverage.json'), JSON.stringify(report, null, 2));
  expect(report.length, 'at least one inventory route must be audited').toBeGreaterThan(0);
  const missing = report.flatMap(row => row.people.filter(person => person.known && !person.loaded).map(person => ({ route: row.route, name: person.name })));
  expect(missing).toEqual([]);
});
