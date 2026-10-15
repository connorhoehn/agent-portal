// Run with:  cd portal && node --test src/pages/runbooks/__tests__/reviewPageSafety.test.ts
// A malicious proposal's document is rendered by the same RunbookDocView the proposal review page (its
// "Read the proposed runbook" disclosure) and the runbook's Read tab draw. node cannot run .tsx, so the
// component is bundled with esbuild (packages external) into node_modules/.cache and imported.
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
const outfile = path.join(outDir, 'RunbookDocView.mjs');
buildSync({
  entryPoints: [path.join(root, 'src/pages/runbooks/RunbookDocView.tsx')], outfile, bundle: true, format: 'esm', platform: 'node',
  packages: 'external', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
});
const { RunbookDocView } = await import(pathToFileURL(outfile).href) as { RunbookDocView: (p: { doc: unknown; markdown?: string; sha256?: string }) => unknown };

const evil = {
  title: '<script>alert("title")</script>',
  summary: '<img src=x onerror=alert(1)> then [click](javascript:alert(2))',
  use_when: ['When `<script>alert(3)</script>` shows up'], not_for: ['<iframe src="https://evil.example"></iframe>'],
  triggers: { work_item_labels: ['<b onmouseover=alert(4)>x</b>'], repos: [], tools: [], keywords: [] },
  preconditions: ['The `onerror="steal()"` handler is absent'],
  steps: [{ do: 'Run `rm -rf /` <script>alert(5)</script>', command: { lang: 'bash', text: 'echo "</code></pre><script>alert(6)</script>"' }, expect: '<img src=x onerror=alert(7)>', why: 'javascript:alert(8)' }],
  verify: [{ check: '<a href="javascript:alert(9)" onclick="x()">check</a>' }],
  failure_modes: [{ symptom: '<svg onload=alert(10)>', cause: '<script>', response: '[r](data:text/html;base64,PHNjcmlwdD4=)' }],
  rollback: [{ do: 'Undo it' }],
  notes: '# Notes\n\n<script>alert(11)</script>\n\n[x](javascript:alert(12))\n\n![t](https://evil.example/p.png)\n\n<img src=x onerror=alert(13)>',
};

test('a malicious proposed runbook renders as inert text on the review page', () => {
  const out = renderToStaticMarkup(createElement(RunbookDocView as never, { doc: evil, markdown: '<script>alert(14)</script>', sha256: 'a'.repeat(64) }));
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /<iframe/i);
  assert.doesNotMatch(out, /<img/i);
  assert.doesNotMatch(out, /<svg[^>]*\sonload/i);   // (the library draws its own chevron svg; only an attacker-supplied one would carry a handler)
  assert.doesNotMatch(out, /<[a-z][^>]*\son\w+=/i);            // no event-handler attribute on any real tag
  assert.doesNotMatch(out, /(href|src)="(javascript|data|vbscript):/i);
  assert.doesNotMatch(out, /rel="preload"/i);
  assert.match(out, /&lt;script&gt;alert\(5\)&lt;\/script&gt;/); // shown to the reviewer as text, so they can see what it was
});
