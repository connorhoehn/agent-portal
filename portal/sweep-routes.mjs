// One-shot sweep: load every route that renders a nav layout and report any
// console/page error. Exists to prove the ui-components reinstall fixed the
// module-resolution errors everywhere, not just on the page that reported them.
import { chromium } from '@playwright/test';

const BASE = 'http://localhost:5183';
const ROUTES = [
  '/', '/iq/projects', '/iq/work', '/iq/distillation', '/iq/local-compute',
  '/iq/designs', '/iq/promotions', '/iq/library', '/iq/release',
  '/iq/invoke', '/iq/explore', '/iq/agents', '/settings',
  '/admin/budgets', '/admin/devbox', '/admin/projects',
  '/admin/observability', '/admin/knowledge', '/admin/capabilities',
  '/admin/identity',
];

// System Chrome rather than Playwright's bundled build: the bundled one is not
// downloaded here, and this script is a local check, not CI.
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const rows = [];

for (const route of ROUTES) {
  const errs = [];
  const onConsole = (m) => { if (m.type() === 'error') errs.push(m.text()); };
  const onPageErr = (e) => errs.push(e.message);
  page.on('console', onConsole);
  page.on('pageerror', onPageErr);
  try {
    await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle', timeout: 20000 });
    await page.waitForTimeout(700);
  } catch (e) {
    errs.push(`NAV: ${e.message.split('\n')[0]}`);
  }
  page.off('console', onConsole);
  page.off('pageerror', onPageErr);

  // Separate the two failure classes: a module-resolution error is a real
  // regression; a 403 is authorization working as designed for this role.
  const modules = errs.filter((e) => /does not provide an export|Failed to fetch dynamically imported|SyntaxError/i.test(e));
  const forbidden = errs.filter((e) => /403|Forbidden/.test(e));
  const other = errs.filter((e) => !modules.includes(e) && !forbidden.includes(e));
  rows.push({ route, modules, forbidden: forbidden.length, other });
}

await browser.close();

let bad = 0;
for (const r of rows) {
  const tag = r.modules.length ? 'MODULE-ERR' : r.other.length ? 'other' : 'ok';
  if (r.modules.length) bad++;
  const notes = [r.forbidden ? `${r.forbidden}×403` : '', ...r.other.slice(0, 1)].filter(Boolean).join(' ');
  console.log(`${tag.padEnd(11)} ${r.route.padEnd(24)} ${notes}`);
  r.modules.forEach((m) => console.log(`            ↳ ${m.slice(0, 160)}`));
}
console.log(`\n${bad === 0 ? 'PASS' : 'FAIL'} — ${bad}/${rows.length} routes with module errors`);
process.exit(bad === 0 ? 0 : 1);
