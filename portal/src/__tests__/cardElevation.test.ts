// Run with:  cd portal && node --test 'src/__tests__/cardElevation.test.ts'
//
// Guards the Elevation block in app.css. That rule gives every card its
// resting shadow by matching the utility classes the LIBRARY's Card paints,
// because CardProps exposes no elevation prop to ask for it with (queued in
// docs/ui-components-queue.md). The selector is therefore coupled to the
// library's internals: if a ui-components bump renames one of those classes,
// nothing throws and nothing typechecks differently — all 294 card sites just
// go flat again, which is the exact regression the rule was added to fix and
// is invisible in a diff. This test is the alarm for that.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIST = join(
  import.meta.dirname,
  '..',
  '..',
  'node_modules',
  '@connorhoehnslalom',
  'ui-components',
  'dist',
);

/** The classes app.css's Elevation selector depends on. */
const REQUIRED = ['rounded-lg', 'border-border', 'bg-surface'];

function cardSource(): string {
  // The dist is content-hashed and code-split, so the chunk name moves on
  // every release — find it by shape rather than by a pinned filename.
  const chunk = readdirSync(DIST).find((f) => /^Card-.*\.js$/.test(f));
  assert.ok(chunk, 'no Card-*.js chunk in the installed ui-components dist');
  return readFileSync(join(DIST, chunk), 'utf8');
}

test('the library Card still paints the classes app.css elevates', () => {
  const src = cardSource();
  for (const cls of REQUIRED) {
    assert.ok(
      src.includes(cls),
      `ui-components Card no longer paints "${cls}". The Elevation rule in ` +
        `portal/src/app.css matches on it, so every card just lost its ` +
        `shadow. Re-point the selector at Card's new classes (or adopt the ` +
        `elevation prop, if this is the release that added one).`,
    );
  }
});

test('app.css elevates cards and de-elevates nested ones', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8');
  const selector = REQUIRED.map((c) => `.${c}`).join('');

  assert.ok(
    css.includes(`${selector} {`),
    'the resting-card elevation rule is missing from app.css',
  );
  assert.ok(
    css.includes(`${selector} ${selector} {`),
    'the nested-card de-elevation rule is missing from app.css — a card ' +
      'inside a card would stack the ambient shadow on itself',
  );
});

test('elevation resolves through --elev-*, which dark mode can reach', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8');

  // Tailwind v4 INLINES an @theme value into the utility it generates, so a
  // shadow written as `shadow-sm` cannot be re-themed at paint time. The rule
  // must name the custom property directly for the dark block to land.
  assert.match(
    css,
    /\.rounded-lg\.border-border\.bg-surface \{\s*box-shadow: var\(--elev-sm\);/,
    'the elevation rule must use var(--elev-sm), not a Tailwind shadow ' +
      'utility — an inlined @theme value ignores the dark-mode override',
  );

  // Light and dark must BOTH define it, or one theme paints nothing.
  const defs = css.match(/^\s*--elev-sm:/gm) ?? [];
  assert.ok(
    defs.length >= 2,
    `--elev-sm is defined ${defs.length} time(s); expected a light and a dark value`,
  );
});

// Unlayered defaults outrank Tailwind utilities regardless of specificity.
// In particular, the library HoverCard's explicit shadow-lg must remain effective.
test('card defaults stay below explicit Tailwind shadow utilities', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'app.css'), 'utf8');
  assert.match(css, /@layer components\s*\{\s*\.rounded-lg\.border-border\.bg-surface\s*\{/);
});
