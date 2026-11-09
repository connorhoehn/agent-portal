// UX walk, 9 November 2026: an org-leader "can see the fleet but not drive it",
// yet the Computer Lab's Nudge bar sent its task and met a 403. A read-only
// viewer's Nudge is refused in place, before any request, with the banner's
// own reason.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READ_ONLY_REASON, refuseInstruction } from '../devboxReadOnly.ts';

test('a read-only Nudge rejects with the banner reason and sends nothing', async () => {
  const sent: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => { sent.push(String(url)); return new Response('{}'); }) as typeof fetch;
  try {
    await assert.rejects(refuseInstruction(), (err: Error) => err.message === READ_ONLY_REASON);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(sent, []);
  assert.match(READ_ONLY_REASON, /see the fleet but not drive it/);
});
