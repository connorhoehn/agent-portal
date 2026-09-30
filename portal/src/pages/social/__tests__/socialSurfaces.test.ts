// Run with:  cd portal && node --test 'src/pages/social/__tests__/*.test.ts'
//
// Every social page the rail and palette offer has an empty state that says
// what it will hold and which lane brings it — none of them is a blank page.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SOCIAL_SURFACES, SOCIAL_SURFACE_IDS } from '../socialSurfaces.ts';

test('the eight rail surfaces of design §4.1 all have a page', () => {
  for (const id of ['channels', 'dms', 'calls', 'rooms', 'contacts', 'teams', 'recordings', 'configuration']) {
    assert.ok(SOCIAL_SURFACE_IDS.includes(id as never), `no page for /social/${id}`);
  }
});

test('every page names what it will hold and the lane that brings it', () => {
  for (const id of SOCIAL_SURFACE_IDS) {
    const s = SOCIAL_SURFACES[id];
    assert.equal(s.id, id);
    for (const field of ['title', 'description', 'emptyTitle', 'emptyBody', 'next'] as const) {
      assert.ok(s[field].trim().length > 0, `${id}.${field} is blank`);
    }
    assert.match(s.phase, /^(S1|S2|N)$/);
    assert.match(s.next, new RegExp(`Lane ${s.phase}\\b`), `${id}.next does not name its lane`);
  }
});
