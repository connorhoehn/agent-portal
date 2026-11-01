import assert from 'node:assert/strict';
import test from 'node:test';
import { briefDocumentMarkdown } from '../briefDocumentMarkdown.ts';
import { documentMarkdownHtml } from '../documentMarkdown.ts';
import type { Brief } from '../types.ts';

const brief: Brief = {
  id: 'brief-1', run_ref: 'job-1', work_item_id: 'wi-1', initiative_id: 'p-1', repo: 'org/service',
  assembled_at: '2026-11-01T12:00:00Z', assembler_version: '1', budget_tokens: 6000, used_tokens: 240,
  sections: [{ kind: 'runbook', ref: 'rb-test', version: 2, tokens: 200, reason: 'Required by the task' }],
  omitted: [{ runbook_id: 'rb-omitted', reason: 'budget' }], sha256: 'a'.repeat(64),
  markdown: '# Session brief — brief-1\n\n## Your task\n\nRestore service.',
  skill_library: { sha256: 'b'.repeat(64), dir: '~/.claude/skills', skills: [{ name: 'rb-test', version: 2 }] },
};
const options = {
  frozen: true, sectionLabel: () => 'Runbook', referenceLabel: () => 'Service recovery v2',
  runbookLabel: () => 'Service recovery', workItemLabel: 'Restore service', initiativeLabel: 'Platform',
  skills: [{ name: 'rb-test', version: 2, title: 'Service recovery', description: 'Restore a failed service.', current_version: 3 }],
};

test('sources, omitted inputs, installed skills and assembly identity are document sections', () => {
  const original = JSON.stringify(brief);
  const html = documentMarkdownHtml(briefDocumentMarkdown(brief, options));
  for (const heading of ['Sources', 'Assembly details']) assert.ok(html.includes(`<h2>${heading}</h2>`));
  for (const heading of ['Included sources', 'Sources left out', 'Skill library']) assert.ok(html.includes(`<h3>${heading}</h3>`));
  assert.match(html, /href="\/iq\/runbooks\/rb-test"/);
  assert.match(html, /v2; current version v3/);
  assert.match(html, /Restore a failed service/);
  assert.match(html, /Over the token budget/);
  assert.ok(html.includes(brief.sha256));
  assert.ok(html.includes(brief.skill_library!.sha256));
  assert.equal(JSON.stringify(brief), original, 'saved instructions and checksums stay unchanged');
});

test('source labels and metadata cannot inject headings or HTML into the document', () => {
  const changed = { ...brief, sections: [{ ...brief.sections[0]!, reason: '\n## Injected heading\n[Surprise](https://evil.example)' }] };
  const html = documentMarkdownHtml(briefDocumentMarkdown(changed, { ...options, referenceLabel: () => '<script>bad()</script>' }));
  assert.doesNotMatch(html, /<script>|<h2>Injected|<a[^>]+>Surprise<\/a>/);
  assert.match(html, /Injected heading/);
});
