// Run with:  cd portal && node --test 'src/pages/pipelines/__tests__/*.test.ts'
//
// Every pipelines page the rail and palette offer has an empty state that
// says what it will hold and which lane brings it — none is a blank page, and
// the nine pages of design §5.3 are all present (a palette row whose route
// 404s fails validate-nav-parity.sh).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PIPELINES_SURFACES, PIPELINES_SURFACE_IDS } from '../pipelinesSurfaces.ts';

test('the nine pages of design §5.3 all have a page', () => {
  for (const id of ['definitions', 'runbooks', 'runs', 'approvals', 'artifacts', 'agents', 'bots', 'commands', 'configuration']) {
    assert.ok(PIPELINES_SURFACE_IDS.includes(id as never), `no page for /pipelines/${id}`);
  }
});

test('every page names what it will hold and the lane that brings it', () => {
  for (const id of PIPELINES_SURFACE_IDS) {
    const s = PIPELINES_SURFACES[id];
    assert.equal(s.id, id);
    for (const field of ['title', 'description', 'emptyTitle', 'emptyBody', 'next'] as const) {
      assert.ok(s[field].trim().length > 0, `${id}.${field} is blank`);
    }
    assert.match(s.phase, /^P[012]$/);
    assert.match(s.next, new RegExp(`Lane ${s.phase}\\b`), `${id}.next does not name its lane`);
  }
});
