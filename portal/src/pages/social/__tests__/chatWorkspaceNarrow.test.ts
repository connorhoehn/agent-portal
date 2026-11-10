// Phone width in the chat workspace (UX walk D, and the regression walk of 9 November, night).
//
// Under 640px the conversation rail and the pane cannot sit side by side: the
// library's narrow explorer shows one at a time, the list or what is open under
// a back control. Lane D gave Social's own pages that form but left the
// embedded plane (Work, Assessment and Pipelines Communication) beside its
// 300px rail, so /iq/communication at 390 squeezed the conversation to one
// character wide. Read from the source, because the workspace is a React page
// this node runner does not render.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const src = readFileSync(new URL('../SocialChatWorkspace.tsx', import.meta.url), 'utf8');

test('the narrow explorer wraps the pane whether or not the workspace is embedded', () => {
  assert.match(src, /\{narrow \? \(\s*<ExplorerLayout rail=\{railNode\}/);
  assert.doesNotMatch(src, /!embedding && narrow \?/);
  // The pane inside it is the embedded SectionContent when embedded, the plain section otherwise.
  assert.match(src, /const paneNode = embedding \? \(/);
  assert.match(src, /narrow=\{\{ showing: paneOpen && !narrowList \? 'record' : 'list', onBack: narrowBack, backLabel: 'All conversations' \}\}/);
});

test('the rail takes the full width at phone width in both forms, and a host view counts as open', () => {
  assert.match(src, /\{\.\.\.\(narrow \? \{ className: 'w-full border-r-0' \} : \{\}\)\}/);
  assert.match(src, /\|\| !!embedding\?\.pane;/);
});
