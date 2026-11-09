// G26: the CC control toggles the turn strip inline above the dock's row at the
// footer scale; pressing it never mounts a dialog or a popover.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VoiceDock } from '@connorhoehn/ui-components/voice';
import { dockTranscriptProps, voiceLogHref, type DockTurn } from '../voiceDockModel.ts';

const turns: DockTurn[] = [
  { id: 't1', role: 'you', text: 'open the initiatives', at: 1 },
  { id: 't2', role: 'assistant', text: 'Opened Initiatives', at: 2, toolCalls: [{ name: 'open', status: 'done', summary: 'Initiatives' }] },
];

function dock(open: boolean, toggle: () => void, extra: { openLog?: () => void } = {}) {
  return renderToStaticMarkup(createElement(VoiceDock, {
    phase: 'listening', level: 0, outputLevel: 0, size: 'footer', 'data-testid': 'shell-voice-dock',
    ...dockTranscriptProps({ open, toggle, turns, keep: false, setKeep: () => {}, openLog: extra.openLog ?? null }),
  }));
}

const NO_OVERLAY = /role="(dialog|alertdialog)"|aria-modal|popover|data-ui-overlay/i;

test('CC toggles the strip inline at the footer scale; no dialog, no popover, ever', () => {
  let open = false;
  const toggle = () => { open = !open; };
  const closed = dock(open, toggle);
  assert.match(closed, /data-testid="shell-voice-dock-cc"[^>]*aria-pressed="false"|aria-pressed="false"[^>]*data-testid="shell-voice-dock-cc"/);
  assert.doesNotMatch(closed, /shell-voice-dock-strip/);
  assert.doesNotMatch(closed, NO_OVERLAY);

  toggle(); // press CC
  const shown = dock(open, toggle);
  assert.doesNotMatch(shown, NO_OVERLAY);
  // Inline: the strip sits inside the dock's root, in the row before the dock's own row, at the footer size.
  const strip = shown.indexOf('data-testid="shell-voice-dock-strip"');
  const row = shown.indexOf('data-testid="shell-voice-dock-row"');
  assert.ok(strip > 0 && row > strip, 'the strip renders above the dock row, inside the dock');
  assert.match(shown, /data-testid="shell-voice-dock-strip" data-size="footer"/);
  assert.match(shown, /open the initiatives/);
  // The keep switch is in the strip's extras row.
  const extras = shown.indexOf('shell-voice-dock-strip-extras');
  assert.ok(extras > 0 && shown.indexOf('shell-voice-dock-strip-keep') > extras);

  toggle(); // press again
  assert.doesNotMatch(dock(open, toggle), /shell-voice-dock-strip/);
});

test('the history control renders only where the log exists, and goes to the session or the latest', () => {
  assert.doesNotMatch(dock(false, () => {}), /shell-voice-dock-history/);
  assert.match(dock(false, () => {}, { openLog: () => {} }), /shell-voice-dock-history/);
  const paths = { list: '/iq/voice-log', session: (id: string) => `/iq/voice-log/${id}` };
  assert.equal(voiceLogHref('vs_1', paths), '/iq/voice-log/vs_1');
  assert.equal(voiceLogHref(null, paths), '/iq/voice-log');
});
