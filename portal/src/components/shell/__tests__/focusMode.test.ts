// Shell focus mode (ui-components 2.548.0): a page that needs the whole screen (a deck presenting in place) asks
// the shell to fold both left rails and gets them back exactly as they were. The library folds every
// `useRailFold` under `ShellFocusModeProvider` without writing storage; this pins that the shell puts the
// provider above every rail it builds, that both of its rails come from `useRailFold`, and that the deck editor
// is the page that asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const layout = read('../Layout.tsx');

test('the provider wraps the side pane host and the shell, so every rail under the shell reads focus mode', () => {
  const body = layout.slice(layout.indexOf('export function Layout()'), layout.indexOf('function ShellLayout()'));
  const provider = body.indexOf('<ShellFocusModeProvider>');
  assert.ok(provider > 0, 'Layout renders ShellFocusModeProvider');
  assert.ok(provider < body.indexOf('<SidePaneProvider') && body.indexOf('<SidePaneProvider') < body.indexOf('<ShellLayout />'));
  assert.ok(body.indexOf('</ShellFocusModeProvider>') > body.indexOf('<ShellLayout />'));
});

test('the primary rail folds through useRailFold, and the rail SubNavLayout draws follows it', () => {
  assert.match(layout, /const primaryRail = useRailFold\(\{ storageKey: 'shell\.primary-rail'/);
  // The dialogue rule passes the fold through when no dialogue is open (useDialogueRailFold: `: rail.folded`).
  assert.match(read('../useDialogueRailFold.ts'), /: rail\.folded;/);
  assert.match(layout, /<SubNavLayout[\s\S]{0,400}collapsed=\{dialogueRail\.folded\}/);
  // No rail of the shell keeps its own collapsed state beside useRailFold (it would miss focus mode).
  assert.doesNotMatch(layout, /useState<boolean>\(\s*false\s*\)[^\n]*[Rr]ail/);
});

test('a page list rail is a useRailFold too (the second left rail), so it folds with the primary', () => {
  assert.match(read('../../../pages/projects/InitiativesExplorer.tsx'), /useRailFold\(\{ storageKey: RAIL_FOLD_KEY \}\)/);
});

test('the deck editor asks for focus mode while it presents in place, and nothing else holds it', () => {
  const page = read('../../decks/DeckEditorPage.tsx');
  assert.match(page, /useShellFocusMode\(\)/);
  assert.match(page, /onFocusModeChange=\{focus\.request\}/);
  assert.doesNotMatch(page, /DeckPresentationDialog|onOpenPresentationView/);
});

test('focus mode folds the primary rail over an open dialogue, and the dialogue choice survives it', () => {
  const rule = read('../useDialogueRailFold.ts');
  assert.match(rule, /const folded = focused \? true :/);
  assert.match(rule, /if \(wasOpen\.current && !open && !focused\) setChoice\(null\)/);
  // The deck page reads the same focus mode to step its own chrome aside while presenting.
  assert.match(read('../../decks/DeckEditorPage.tsx'), /const presenting = focus\.active;/);
});
