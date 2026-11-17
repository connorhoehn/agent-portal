// The Candidates staff pages the rendered-UI audit walks (e2e/route-inventory.ts INTERVIEWS_STAFF_ROUTES): each row
// names the seeded role that uses the page, and every staff route of App.tsx has a row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INTERVIEWS_STAFF_ROUTES, staticInventory } from '../../../e2e/route-inventory.ts';

test('every staff row is inventoried as its own role, not the sweep user', () => {
  const inv = staticInventory().filter((r) => r.tenant === 'interviews');
  for (const row of INTERVIEWS_STAFF_ROUTES) {
    const found = inv.find((r) => r.path === row.path);
    assert.ok(found, `${row.path} is in the inventory`);
    assert.equal(found.user, row.user, `${row.path} is walked as ${row.user}`);
  }
});

test('every staff route in App.tsx has an inventory row', () => {
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8');
  const patterns = [...app.matchAll(/<Route path="((?:candidates|openings|rounds|upcoming|my-interviews|my-openings)[^"]*)"/g)].map((m) => `/interviews/${m[1]}`);
  assert.ok(patterns.length >= 15, 'the routes are read from App.tsx');
  const shape = (p: string) => p.replace(/:[A-Za-z]+/g, ':id');
  const rows = INTERVIEWS_STAFF_ROUTES.map((r) => shape((r.pattern ?? r.path).replace(/ \(.*\)$/, '').replace(/\/(cand|op|iv)-[a-z0-9]+/g, '/:id')));
  for (const p of patterns) {
    // Two redirects (the bell's round, and a round's debrief) land on a page that has its own row.
    if (p === '/interviews/rounds/:id' || p === '/interviews/rounds/:id/debrief') continue;
    assert.ok(rows.includes(shape(p)), `${p} has a row`);
  }
});
