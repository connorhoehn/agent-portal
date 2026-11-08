// Every palette page has a stable, tenant-unique pageId (docs/voice/page-ids.md).
// The last test prints the whole "tenant: id → path" table so a reviewer reads it in one place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PALETTE } from '../../../lib/voice/__tests__/voiceHarness.ts';

const PAGES = PALETTE.pages;

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;

test('every PAGES row has a kebab-case pageId', () => {
  assert.equal(PAGES.length, 110);
  for (const p of PAGES) {
    assert.ok(p.pageId, `${p.tenant} ${p.path} has no pageId`);
    assert.match(p.pageId!, KEBAB, `${p.tenant} ${p.path}`);
  }
});

test('pageIds are unique within each tenant', () => {
  const seen = new Map<string, string>();
  for (const p of PAGES) {
    const key = `${p.tenant}:${p.pageId}`;
    assert.ok(!seen.has(key), `${key} used by ${seen.get(key)} and ${p.path}`);
    seen.set(key, p.path);
  }
});

test('the full id table (tenant: id → path)', () => {
  const table = PAGES.map((p) => `${p.tenant}: ${p.pageId} → ${p.path}`).sort();
  console.log(`\n${table.join('\n')}\n`);
  assert.equal(new Set(table).size, 110);
});
