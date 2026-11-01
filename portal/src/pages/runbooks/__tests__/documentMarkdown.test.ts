import assert from 'node:assert/strict';
import test from 'node:test';
import { documentMarkdownHtml } from '../documentMarkdown.ts';

test('workspace snapshot preserves heading hierarchy, links, code and tables', () => {
  const html = documentMarkdownHtml('# Guide\n\n## Prepare\n\n### Check\n\n[Runbook](/iq/runbooks/rb-a)\n\n```sh\necho "ok"\n```\n\n| Name | Value |\n| --- | --- |\n| A | B |');
  assert.match(html, /<h1>Guide<\/h1>/);
  assert.match(html, /<h2>Prepare<\/h2>/);
  assert.match(html, /<h3>Check<\/h3>/);
  assert.match(html, /href="\/iq\/runbooks\/rb-a"/);
  assert.match(html, /<pre><code class="language-sh">echo &quot;ok&quot;/);
  assert.match(html, /<table>/);
});

test('workspace snapshot cannot load remote images or execute document markup', () => {
  const html = documentMarkdownHtml('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n![pixel](https://evil.example/p.gif)\n\n[bad](javascript:alert(1)) [data](data:text/html,bad)');
  assert.doesNotMatch(html, /<(script|img|iframe)/i);
  assert.doesNotMatch(html, /href="(javascript|data):/i);
  assert.match(html, /image omitted/);
});

import { briefReadingMarkdown, runbookDisplayTitle, runbookReadingMarkdown } from '../runbookTitles.ts';
test('reading headers use concise labels without dropping instructions or authored names', () => {
  const original = '# Release a packed-tarball library and move every consumer pin to it\n\n## Steps\n\nDo the work.';
  assert.match(runbookReadingMarkdown(original), /^# Library release and consumer updates/);
  assert.match(runbookReadingMarkdown(original), /## Steps\n\nDo the work\./);
  assert.equal(runbookDisplayTitle('My team’s guide'), 'My team’s guide');
  assert.equal(briefReadingMarkdown('# Session brief — wi-raw-id\n\n> Assembled 2026 for preview-wi-id\n\n## Your task\nDo the work.'), '# Session brief\n\n## Your task\nDo the work.');
});

test('brief reading structure separates task metadata and project context from prose', () => {
  const source = '# Session brief — x\n\n## Your task\n**Restore alerts** (bug, 2 pts)\nThe service needs attention.\nLabels: blocked.\n\n## The project\n**Observability** — repo org/service.';
  const reading = briefReadingMarkdown(source);
  assert.match(reading, /## Your task\n\n### Restore alerts\n\n_\(bug, 2 pts\)_\n\nThe service needs attention\.\n\n_Labels:/);
  assert.match(reading, /## The project\n\n### Observability\n\n_repo org\/service\._/);
});
