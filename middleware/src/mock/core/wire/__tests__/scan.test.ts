// The bug, reconstructed — and the reasons the check stays quiet otherwise.
//
// The first test here is the whole point of the mechanism: given the real
// response shape of GET /api/assessment/knowledge/tree, a fixture keyed
// `enterprise` must be named, at its line, in a sentence a developer can act
// on without curling anything.

import { buildVocabulary, matchObject, valuesFor, type WireSnapshotFile } from '../vocabulary.js';
import { corpusOf } from '../corpus.js';
import { scanSource, formatFindings } from '../scan.js';

/** The real thing, trimmed: what `GET /api/assessment/knowledge/tree` sends. */
const SNAPSHOT: WireSnapshotFile = {
  capturedAt: '2026-09-07T00:00:00.000Z',
  baseUrl: 'http://127.0.0.1:3011',
  personas: ['orgiq/admin'],
  routes: {
    'GET /api/assessment/knowledge/tree': {
      persona: 'orgiq/admin',
      status: 200,
      shape: {
        $: 'object',
        sections: 'array',
        'sections[]': 'object',
        'sections[].key': 'string',
        'sections[].kind': 'string',
        'sections[].title': 'string',
        'sections[].nodes': 'array',
        'sections[].nodes[]': 'object',
        'sections[].nodes[].id': 'string',
        'sections[].nodes[].title': 'string',
        'sections[].nodes[].is_dir': 'boolean',
        'sections[].nodes[].classification': 'string',
      },
      values: {
        'sections[].key': ['confluence-eng', 'enterprise_context', 'prompts', 'rules'],
        'sections[].kind': ['local', 'synced'],
        'sections[].nodes[].classification': ['internal'],
      },
    },
    'GET /api/assessment/teams': {
      persona: 'orgiq/admin',
      status: 200,
      shape: {
        $: 'array',
        '$[]': 'object',
        '$[].id': 'string',
        '$[].name': 'string',
        '$[].status': 'string',
      },
      values: { '$[].status': ['ASSESSED', 'IN_PROGRESS', 'NEW'] },
    },
  },
  vocabulary: {},
};

const vocab = buildVocabulary(SNAPSHOT);
/** A server that knows nothing but what the snapshot showed. */
const corpus = corpusOf([
  "export const SECTIONS = ['enterprise_context', 'rules', 'prompts', 'confluence-eng'];",
  "export type TeamStatus = 'NEW' | 'IN_PROGRESS' | 'ASSESSED';",
]);

describe('the bug this exists for', () => {
  const fixture = `
    const ENTERPRISE = {
      key: 'enterprise',
      title: 'Enterprise Context',
      kind: 'local',
      nodes: [],
    };
  `;

  it('names the fixture, the key and what the server actually sends', () => {
    const findings = scanSource('portal/src/pages/assessment/__tests__/knowledgeFormat.test.ts', fixture, vocab, corpus);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(f!.kind).toBe('value');
    expect(f!.field).toBe('key');
    expect(f!.value).toBe('enterprise');
    expect(f!.line).toBe(3);
    expect(f!.message).toContain('knowledgeFormat.test.ts');
    expect(f!.message).toContain('invents key `enterprise`');
    expect(f!.message).toContain("'enterprise_context'");
    expect(f!.message).toContain('GET /api/assessment/knowledge/tree');
  });

  it('reads without curling anything', () => {
    const out = formatFindings(scanSource('knowledgeFormat.test.ts', fixture, vocab, corpus));
    expect(out).toContain('1 fixture(s) disagree');
    expect(out).toContain('knowledgeFormat.test.ts:3');
    expect(out).toContain('may omit a field the server sends. It may never invent one');
  });

  it('passes once the fixture uses the key the server sends', () => {
    const fixed = fixture.replace("'enterprise'", "'enterprise_context'");
    expect(scanSource('knowledgeFormat.test.ts', fixed, vocab, corpus)).toEqual([]);
  });
});

describe('a fixture may omit, never invent', () => {
  it('says nothing about a fixture that carries only some of the fields', () => {
    const source = `const s = { key: 'rules', title: 'Rules', kind: 'local' };`;
    expect(scanSource('x.test.ts', source, vocab, corpus)).toEqual([]);
  });

  it('names a key no response carries', () => {
    const source = `
      const s = { key: 'rules', title: 'Rules', kind: 'local', nodes: [], sectionKey: 'rules' };
    `;
    const findings = scanSource('x.test.ts', source, vocab, corpus);
    expect(findings.map((f) => f.field)).toEqual(['sectionKey']);
    expect(findings[0]!.message).toContain('invents key `sectionKey`');
  });

  it('leaves a spread alone — its key set is a patch, not the whole object', () => {
    const source = `
      const s = { ...base, key: 'rules', title: 'Rules', kind: 'local', nodes: [], invented: 1 };
    `;
    expect(scanSource('x.test.ts', source, vocab, corpus).filter((f) => f.kind === 'key')).toEqual([]);
  });
});

describe('the two witnesses', () => {
  it('accepts a value the capture missed but the server source spells', () => {
    // Captured as one persona, so `status` only ever showed ASSESSED/NEW/…;
    // a status the server code knows about is real all the same.
    const wider = corpusOf(["const S = ['NEW', 'IN_PROGRESS', 'ASSESSED', 'ARCHIVED'];"]);
    const source = `const t = { id: 'A', name: 'Alpha', status: 'ARCHIVED' };`;
    expect(scanSource('x.test.ts', source, vocab, wider)).toEqual([]);
  });

  it('rejects a value neither witness has heard of', () => {
    const source = `const t = { id: 'A', name: 'Alpha', status: 'paused' };`;
    const findings = scanSource('x.test.ts', source, vocab, corpus);
    expect(findings.map((f) => f.value)).toEqual(['paused']);
    expect(findings[0]!.message).toContain('no middleware source file spells');
  });
});

describe('what is deliberately left alone', () => {
  it('ignores an object that is not imitating a response at all', () => {
    const source = `const opts = { retries: 3, backoffMs: 50, jitter: true, label: 'x' };`;
    expect(scanSource('x.test.ts', source, vocab, corpus)).toEqual([]);
  });

  it('ignores a two-key object — too little to attribute to anything', () => {
    expect(matchObject(vocab, ['id', 'name'])).toBeNull();
  });

  it('does not attribute a generic object to one arbitrary response', () => {
    // {id, name} + status matches whatever carries those three. When several
    // shapes fit, a value is only invented if NONE of them sends it.
    const match = matchObject(vocab, ['id', 'name', 'status']);
    expect(match).not.toBeNull();
    expect(valuesFor(match!, 'status').has('ASSESSED')).toBe(true);
  });
});
