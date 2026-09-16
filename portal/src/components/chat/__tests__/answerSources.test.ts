// Run with:  cd portal && node --test 'src/components/chat/__tests__/*.test.ts'
//
// Plain node:test — the portal has no test runner in package.json and adding
// one is out of scope here. Node strips the types; every module under test is
// pure TypeScript with no JSX and no DOM.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  deriveSources,
  extractSources,
  labelFor,
  provenanceNote,
  retrievedDocuments,
} from '../answerSources.ts';
import { friendlyToolName, summarizeToolCalls } from '../toolCallSummary.ts';

const S3 = 's3://orgiq-documents-647757222309-us-east-1/perf/perf-Theo%20Williams.txt';

// ── The four cases the audit named ───────────────────────────────────────────

test('empty input yields no sources and no note', () => {
  const r = extractSources('');
  assert.equal(r.cleaned, '');
  assert.deepEqual(r.sources, []);
  assert.equal(r.provenance.unverifiedClaims, 0);
  assert.equal(provenanceNote(r.sources, r.provenance), null);
});

test('prose with no citation bracket is left exactly alone', () => {
  const text = 'Sarah Thompson (87.63) and Marcus Müller (77.31) lead on Kubernetes.';
  const r = extractSources(text);
  assert.equal(r.cleaned, text);
  assert.deepEqual(r.sources, []);
  assert.equal(r.provenance.unverifiedClaims, 0);
});

test('a non-URI bracket is removed, not leaked as literal text', () => {
  // The exact string a stored answer shipped to a user.
  const text =
    '…sourced from the relational graph (people, person_skills, skills). [Source: Search agent]';
  const r = extractSources(text);
  assert.ok(!r.cleaned.includes('[Source:'), `bracket leaked: ${r.cleaned}`);
  assert.ok(!r.cleaned.includes('Search agent'), `internal agent name leaked: ${r.cleaned}`);
  assert.deepEqual(r.sources, []);
  assert.equal(r.provenance.unverifiedClaims, 1);
  assert.equal(
    provenanceNote(r.sources, r.provenance),
    'removed 1 citation with no source behind it',
  );
});

test('a real s3 URI becomes a chip with a readable label', () => {
  const r = extractSources(`Theo's review says so. [Source: ${S3}]`);
  assert.ok(!r.cleaned.includes('[Source:'));
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0]?.uri, S3);
  assert.equal(r.sources[0]?.label, 'perf-Theo Williams');
  assert.equal(r.sources[0]?.kind, 'document');
  assert.equal(r.sources[0]?.origin, 'prose');
  assert.equal(r.provenance.unverifiedClaims, 0);
});

// ── The shapes the fleet actually emits ──────────────────────────────────────

test('the emphasised form the supervisor really writes is stripped', () => {
  // Captured live, 2026-08: "*Source: Scoring specialist*".
  const r = extractSources(
    '1. Sarah Thompson with a score of 87.63\n\n*Source: Scoring specialist*',
  );
  assert.ok(!r.cleaned.includes('Scoring specialist'), r.cleaned);
  assert.ok(r.cleaned.includes('Sarah Thompson'));
  assert.equal(r.provenance.unverifiedClaims, 1);
});

test('a bolded citation bullet is dropped whole, leaving no orphan marker', () => {
  const r = extractSources(
    '2. **Marcus Müller**\n   - **Sources**: Relational graph\n   - Score: 77.31',
  );
  assert.ok(!r.cleaned.includes('Relational graph'), r.cleaned);
  assert.ok(!/^\s*-\s*$/m.test(r.cleaned), `orphan list marker left: ${JSON.stringify(r.cleaned)}`);
  assert.ok(r.cleaned.includes('Score: 77.31'));
});

test('a URI inside an otherwise prose citation line is still harvested', () => {
  const r = extractSources(`Sources: see ${S3} for the full review`);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0]?.uri, S3);
  assert.equal(r.provenance.unverifiedClaims, 0);
});

test('an unclosed bracket mid-stream is hidden, not flashed', () => {
  const r = extractSources('Sarah leads on Kubernetes. [Source: s3://bucket/partial');
  assert.equal(r.cleaned, 'Sarah leads on Kubernetes.');
});

// ── Labels ───────────────────────────────────────────────────────────────────

test('an opaque object key does not render as a bare UUID', () => {
  const label = labelFor('s3://orgiq-documents/raw/8f14e45f-ceea-467a-9f2b-3c1d0a4b7e21.txt');
  assert.equal(label, 'document 8f14e45f…');
});

test('a label never falls back to the whole URI', () => {
  assert.equal(labelFor('s3://orgiq-documents-647757222309-us-east-1/'), 'orgiq-documents-647757222309-us-east-1');
});

test('the middleware-annotated title wins over the derived label', () => {
  const result = JSON.stringify([
    { content: '…', score: 0.71, source: S3, title: 'Performance review — Theo Williams' },
  ]);
  const r = deriveSources({
    content: 'Theo has led two migrations.',
    toolCalls: [{ name: 'query_knowledge_base', args: '{}', result }],
  });
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0]?.label, 'Performance review — Theo Williams');
  assert.equal(r.provenance.documentsRetrieved, 1);
});

test('retrieval results are read in the un-annotated and Bedrock shapes too', () => {
  assert.deepEqual(retrievedDocuments(JSON.stringify([{ source: S3 }])), [{ uri: S3 }]);
  assert.deepEqual(
    retrievedDocuments(JSON.stringify([{ location: { s3Location: { uri: S3 } } }])),
    [{ uri: S3 }],
  );
  assert.deepEqual(retrievedDocuments(JSON.stringify([{ source: 'unknown' }])), []);
  assert.deepEqual(retrievedDocuments(undefined), []);
  assert.deepEqual(retrievedDocuments('not json'), []);
});

// ── Provenance derived from tool calls ───────────────────────────────────────

test('a graph query names the tables it read, not the agent that ran it', () => {
  const r = deriveSources({
    content: 'Sarah Thompson and Marcus Müller.',
    toolCalls: [
      {
        name: 'query_graph',
        args: JSON.stringify({
          sql: 'SELECT p.name FROM people p JOIN person_skills ps ON ps.person_id = p.id JOIN skills s ON s.id = ps.skill_id',
        }),
        result: '[]',
      },
    ],
  });
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0]?.kind, 'graph');
  assert.equal(r.sources[0]?.label, 'org graph: people, person_skills, skills');
  assert.equal(r.sources[0]?.uri, undefined);
});

test('an A2A hop chips the data it consulted, never the specialist', () => {
  // The live supervisor turn: one get_expertise_scores call, prose result.
  const r = deriveSources({
    content: 'The top two experts are Sarah Thompson and Marcus Müller.\n\n*Source: Scoring specialist*',
    toolCalls: [
      {
        name: 'get_expertise_scores',
        args: '{"request":"top 2 Kubernetes experts"}',
        result: '"The top 2 Kubernetes experts are:\\n1. Sarah Thompson…"',
      },
    ],
  });
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0]?.label, 'expertise scores');
  assert.ok(!r.cleaned.includes('Scoring specialist'));
  assert.ok(!JSON.stringify(r.sources).includes('specialist'));
  assert.equal(r.provenance.toolCalls, 1);
});

test('a supervisor search hop chips the documents it cited, not a generic A2A label', () => {
  // search_organization routes to the Search agent, which returns prose that
  // cites its KB documents inline as [Source: s3://…] — not a JSON array.
  const r = deriveSources({
    content: 'Theo led two migrations.',
    toolCalls: [
      {
        name: 'search_organization',
        args: '{"query":"who knows kubernetes"}',
        result: `Theo led two migrations. [Source: ${S3}]`,
      },
    ],
  });
  assert.equal(r.provenance.retrievalCalls, 1);
  assert.equal(r.provenance.documentsRetrieved, 1);
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0]?.uri, S3);
  assert.equal(r.sources[0]?.kind, 'document');
  assert.equal(r.sources[0]?.origin, 'tool');
  assert.equal(r.sources[0]?.label, 'perf-Theo Williams');
  // The generic placeholder must be gone.
  assert.ok(!JSON.stringify(r.sources).includes('org graph + knowledge base'));
  assert.equal(provenanceNote(r.sources, r.provenance), null);
});

test('a supervisor search that cited no document reads as an empty knowledge base', () => {
  // The case a low-corpus lab actually hits: the hop ran, cited nothing.
  const r = deriveSources({
    content: 'I could not find anything on that.',
    toolCalls: [
      { name: 'search_organization', args: '{"query":"quantum"}', result: 'No matching documents were found.' },
    ],
  });
  assert.deepEqual(r.sources, []);
  assert.equal(r.provenance.retrievalCalls, 1);
  assert.equal(r.provenance.documentsRetrieved, 0);
  assert.equal(
    provenanceNote(r.sources, r.provenance),
    'knowledge base searched — no documents matched',
  );
});

test('a search hop citing the same doc the answer repeats yields one tool chip', () => {
  // The URI is in both the tool result and the relayed answer prose; dedup and
  // tool-origin must win.
  const r = deriveSources({
    content: `Theo led two migrations. [Source: ${S3}]`,
    toolCalls: [
      { name: 'search_organization', args: '{}', result: `Theo led two migrations. [Source: ${S3}]` },
    ],
  });
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0]?.origin, 'tool');
  assert.equal(r.provenance.documentsRetrieved, 1);
});

test('observed sources are numbered ahead of model-written ones', () => {
  const r = deriveSources({
    content: `Also see [Source: https://wiki.example.com/kubernetes].`,
    toolCalls: [
      { name: 'query_graph', args: JSON.stringify({ sql: 'SELECT 1 FROM people' }), result: '[]' },
    ],
  });
  assert.deepEqual(r.sources.map((s) => [s.n, s.origin]), [[1, 'tool'], [2, 'prose']]);
});

test('the same document cited twice yields one chip', () => {
  const r = deriveSources({
    content: `[Source: ${S3}] and again [Source: ${S3}]`,
    toolCalls: [
      { name: 'query_knowledge_base', args: '{}', result: JSON.stringify([{ source: S3 }]) },
    ],
  });
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0]?.origin, 'tool');
});

// ── The four empty states read differently ───────────────────────────────────

test('empty knowledge base says so instead of rendering nothing', () => {
  const r = deriveSources({
    content: 'I could not find anything on that.',
    toolCalls: [{ name: 'query_knowledge_base', args: '{}', result: '[]' }],
  });
  assert.deepEqual(r.sources, []);
  assert.equal(r.provenance.retrievalCalls, 1);
  assert.equal(r.provenance.documentsRetrieved, 0);
  assert.equal(
    provenanceNote(r.sources, r.provenance),
    'knowledge base searched — no documents matched',
  );
});

test('a searched-but-uncited retrieval still chips what it returned', () => {
  const r = deriveSources({
    content: 'Theo has led two migrations.',
    toolCalls: [
      { name: 'query_knowledge_base', args: '{}', result: JSON.stringify([{ source: S3 }]) },
    ],
  });
  assert.equal(r.sources.length, 1);
  assert.equal(provenanceNote(r.sources, r.provenance), null);
});

test('a tool that is not a source of evidence says so', () => {
  const r = deriveSources({
    content: '42',
    toolCalls: [{ name: 'run_in_sandbox', args: '{}', result: '42' }],
  });
  assert.equal(provenanceNote(r.sources, r.provenance), 'no document sources for this answer');
});

test('both failures are reported together', () => {
  const r = deriveSources({
    content: 'Nothing found. [Source: Search agent]',
    toolCalls: [{ name: 'query_knowledge_base', args: '{}', result: '[]' }],
  });
  assert.equal(
    provenanceNote(r.sources, r.provenance),
    'knowledge base searched — no documents matched · removed 1 citation with no source behind it',
  );
});

// ── Tool summary phrasing ────────────────────────────────────────────────────

test('supervisor tools summarize as data, and build_graph is not a query', () => {
  assert.equal(
    summarizeToolCalls([{ name: 'get_expertise_scores' }, { name: 'get_expertise_scores' }]),
    'read expertise scores ×2',
  );
  assert.equal(summarizeToolCalls([{ name: 'build_graph' }]), 'updated the org graph');
  assert.equal(summarizeToolCalls([{ name: 'query_knowledge_base' }]), 'searched knowledge base');
  assert.equal(summarizeToolCalls([]), null);
});

// friendlyToolName is the per-call form of the same FRIENDLY table
// summarizeToolCalls uses — it backs the tool-call pills InvokePage passes to
// MessageBubble, so pills read "searched knowledge base" rather than a raw
// tool id, with no separate summary line duplicating the same information.
test('friendlyToolName maps a single tool id the same way summarizeToolCalls does', () => {
  assert.equal(friendlyToolName('query_knowledge_base'), 'searched knowledge base');
  assert.equal(friendlyToolName('get_expertise_scores'), 'read expertise scores');
  assert.equal(friendlyToolName('build_graph'), 'updated the org graph');
  // Unknown tools keep their raw name rather than disappearing or throwing.
  assert.equal(friendlyToolName('some_unmapped_tool'), 'some_unmapped_tool');
});
