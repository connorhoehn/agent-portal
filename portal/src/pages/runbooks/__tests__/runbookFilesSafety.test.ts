// Run with:  cd portal && node --test src/pages/runbooks/__tests__/runbookFilesSafety.test.ts
// A file a box wrote is rendered by RunbookFiles (runbook page and proposal review). It must reach the DOM as text.
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
const outfile = path.join(outDir, 'RunbookFiles.mjs');
buildSync({
  entryPoints: [path.join(root, 'src/pages/runbooks/RunbookFiles.tsx')], outfile, bundle: true, format: 'esm', platform: 'node',
  packages: 'external', jsx: 'automatic', logLevel: 'silent', loader: { '.css': 'empty' },
});
const { RunbookFiles } = await import(pathToFileURL(outfile).href) as { RunbookFiles: (p: { files: unknown[] }) => unknown };

test('a malicious file renders as escaped text, in a collapsed disclosure', () => {
  const content = '<img src=x onerror=alert(1)><script>alert(1)</script>';
  const out = renderToStaticMarkup(createElement(RunbookFiles as never, {
    files: [{ path: 'scripts/<b>x.sh', content, mode: '755', sha256: 'f'.repeat(64), size: content.length }],
  }));
  assert.doesNotMatch(out, /<script/i);
  assert.doesNotMatch(out, /<img/i);
  assert.doesNotMatch(out, /<b>x/i);
  assert.doesNotMatch(out, /<[a-z][^>]*\son\w+=/i);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /script/);       // the mode label
  assert.match(out, /ffffffffffff/); // short sha
});
