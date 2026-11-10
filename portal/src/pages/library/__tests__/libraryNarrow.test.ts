// The agent-library record at phone width (UX leftovers, 10 November).
//
// At 390 the record sat beside the section rail and the list rail, so the
// trail band and its h1 had no room and the page showed no heading. The
// stacked catalog now takes the library SectionLayout's narrow form when the
// page asks for it: with a record open, the record fills the width under a
// back control named for the list, and the one h1 stays. Read from the source:
// these are React layouts this node runner does not render.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const layout = readFileSync(new URL('../../../components/shell/StackedCatalogLayout.tsx', import.meta.url), 'utf8');
const page = readFileSync(new URL('../LibraryPage.tsx', import.meta.url), 'utf8');

test('the library asks for the narrow catalog', () => {
  assert.match(page, /<StackedCatalogLayout\s+catalogOverview narrow /);
});

test('the stacked catalog shows the record, not the list rail, when one is open at phone width', () => {
  assert.match(layout, /narrow: overview \? \{\} : \{ list: \{ showing: selectedId \? 'record' as const : 'list' as const, onBack: \(\) => navigate\(listHref\), backLabel: listTitle \} \}/);
});
