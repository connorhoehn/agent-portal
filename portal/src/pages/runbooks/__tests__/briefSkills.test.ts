// Run with:  cd portal && node --test src/pages/runbooks/__tests__/briefSkills.test.ts
// R8: the brief page lists the skills the box received (name linking to the runbook, one-line
// description, version) and says where the library went, honestly, including "not installed".
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildSync } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const outDir = path.join(root, 'node_modules/.cache/runbooks-test');
mkdirSync(outDir, { recursive: true });
const outfile = path.join(outDir, 'BriefSkills.mjs');
buildSync({
  entryPoints: [path.join(root, 'src/pages/runbooks/BriefSkills.tsx')], outfile, bundle: true, format: 'esm', platform: 'node',
  packages: 'external', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
});
const mod = await import(pathToFileURL(outfile).href) as {
  BriefSkills: (p: unknown) => unknown;
  skillLibraryWhere: (lib: { sha256: string; dir: string | null; skills: unknown[] }, frozen: boolean) => string;
};

const sha = 'a'.repeat(64);
const library = (dir: string | null) => ({ sha256: sha, dir, skills: [{ name: 'rb-ws-cdp-debug', version: 2 }, { name: 'rb-gone', version: 1 }] });
const details = [{ name: 'rb-ws-cdp-debug', version: 2, title: 'Watch websocket frames', description: 'Watch a page’s websocket frames over CDP. Use when: <b>debugging</b>.', current_version: 3 }];

test('every skill the brief recorded is listed, linked to its runbook, with its version', () => {
  const out = renderToStaticMarkup(createElement(mod.BriefSkills as never, { library: library('~/.claude/skills'), skills: details, frozen: true, onOpen: () => undefined }));
  assert.match(out, /href="\/iq\/runbooks\/rb-ws-cdp-debug"/);
  assert.match(out, /href="\/iq\/runbooks\/rb-gone"/);
  assert.match(out, /Watch a page’s websocket frames over CDP/);
  assert.match(out, /v2 \(now v3\)/);
  assert.match(out, /v1/);
  assert.match(out, /no longer in the store/);
  // Descriptions are text, never markup.
  assert.doesNotMatch(out, /<b>debugging/);
  assert.match(out, /Skills the box received/);
});

test('where the library went is said honestly', () => {
  assert.match(mod.skillLibraryWhere(library('~/.claude/skills'), true), /Installed in ~\/\.claude\/skills/);
  assert.match(mod.skillLibraryWhere(library('./.claude/skills'), true), /project skills in the run’s checkout/);
  assert.match(mod.skillLibraryWhere(library(null), true), /Not installed/);
});
