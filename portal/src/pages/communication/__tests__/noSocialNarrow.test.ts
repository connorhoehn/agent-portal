// Communication without a Social grant at phone width (UX leftovers, 10 November).
//
// With a grant the embedded plane is SocialChatWorkspace, which took the narrow
// list-then-conversation form on 9 November (chatWorkspaceNarrow.test.ts). The
// Pipelines cast holds no Social grant, so their plane is the Calls rail beside
// an explanation, and at 390 the 300px rail squeezed the explanation to one word
// a line. It now takes the same library narrow explorer: the explanation (or
// Calls) first, the rail under "All conversations". Read from the source: the
// plane is a React page this node runner does not render.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../CommunicationPlane.tsx', import.meta.url), 'utf8');

test('the no-grant plane is its own component with the narrow explorer under 640px', () => {
  assert.match(src, /return <NoSocialPlane route=\{route\}/);
  assert.match(src, /const narrow = useViewportWidth\(\) < NARROW_PX;/);
  assert.match(src, /<ExplorerLayout rail=\{rail\} railLabel="conversations"/);
  assert.match(src, /narrow=\{\{ showing: narrowList \? 'list' : 'record', onBack: \(\) => setNarrowList\(true\), backLabel: 'All conversations' \}\}/);
});

test('beside the content on a wide screen, full width when it is the list', () => {
  assert.match(src, /\) : <>\{rail\}\{content\}<\/>\}/);
  assert.match(src, /\{\.\.\.\(narrow \? \{ className: 'w-full border-r-0' \} : \{\}\)\}/);
});
