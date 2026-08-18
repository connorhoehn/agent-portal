// Linker validation tests.
//
// Extraction quality is the model's problem; what this layer must guarantee is
// that a confident hallucination cannot become a graph write. Every link has
// to name a real candidate AND quote text that is really in the document —
// both gates, because the characteristic failure of an extraction model is
// inventing something plausible.

jest.mock('../aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { validateLinks, type Candidate } from '../doc-linker.js';

const CANDIDATES: Candidate[] = [
  { entityType: 'person', entityId: 'p-001', name: 'Sarah Thompson' },
  { entityType: 'skill', entityId: 'sk-mlops', name: 'MLOps' },
  { entityType: 'project', entityId: 'proj-rag', name: 'RAG Platform' },
];

const TEXT = [
  'OrgIQ announced today that Sarah Thompson will lead the RAG Platform rewrite.',
  'The team credits its MLOps practice for the speed of the migration.',
].join('\n');

describe('closed vocabulary', () => {
  it('drops an id the model invented', () => {
    // The real id is sk-mlops. A hand-written proposal once used s-mlops and
    // blew up at apply time; here it must never become a proposal at all.
    const out = validateLinks(
      [{ entityId: 's-mlops', entityType: 'skill', quote: 'MLOps practice', confidence: 0.9 }],
      CANDIDATES, TEXT,
    );
    expect(out).toEqual([]);
  });

  it('takes type and name from the candidate, not from the model', () => {
    const out = validateLinks(
      [{ entityId: 'p-001', entityType: 'skill', quote: 'Sarah Thompson', confidence: 0.9 }],
      CANDIDATES, TEXT,
    );
    expect(out[0]).toMatchObject({ entityType: 'person', name: 'Sarah Thompson' });
  });
});

describe('evidence must be real', () => {
  it('drops a link whose quote is not in the document', () => {
    const out = validateLinks(
      [{ entityId: 'p-001', quote: 'Sarah Thompson was fired', confidence: 0.95 }],
      CANDIDATES, TEXT,
    );
    expect(out).toEqual([]);
  });

  it('drops a link with no quote at all', () => {
    const out = validateLinks([{ entityId: 'p-001', confidence: 1 }], CANDIDATES, TEXT);
    expect(out).toEqual([]);
  });

  it('matches quotes case-insensitively — casing is not a claim', () => {
    const out = validateLinks(
      [{ entityId: 'sk-mlops', quote: 'mlops practice', confidence: 0.8 }],
      CANDIDATES, TEXT,
    );
    expect(out).toHaveLength(1);
  });
});

describe('confidence', () => {
  it('clamps out-of-range values rather than storing them', () => {
    // confidence is NUMERIC(3,2) CHECK (BETWEEN 0 AND 1) — an unclamped 1.5
    // would fail the insert and lose the whole analysis.
    const out = validateLinks(
      [{ entityId: 'p-001', quote: 'Sarah Thompson', confidence: 1.5 },
       { entityId: 'sk-mlops', quote: 'MLOps practice', confidence: -2 }],
      CANDIDATES, TEXT,
    );
    expect(out[0]?.confidence).toBe(1);
    expect(out[1]?.confidence).toBe(0);
  });

  it('defaults a missing confidence instead of writing NaN', () => {
    const out = validateLinks([{ entityId: 'p-001', quote: 'Sarah Thompson' }], CANDIDATES, TEXT);
    expect(out[0]?.confidence).toBe(0.5);
  });
});

describe('shape robustness', () => {
  it('survives a non-array payload', () => {
    expect(validateLinks(undefined, CANDIDATES, TEXT)).toEqual([]);
    expect(validateLinks({ nope: true }, CANDIDATES, TEXT)).toEqual([]);
  });

  it('de-duplicates repeated claims about one entity', () => {
    const out = validateLinks(
      [{ entityId: 'p-001', quote: 'Sarah Thompson', confidence: 0.9 },
       { entityId: 'p-001', quote: 'Sarah Thompson will lead', confidence: 0.8 }],
      CANDIDATES, TEXT,
    );
    expect(out).toHaveLength(1);
  });

  it('caps how many links one document can claim', () => {
    const many = Array.from({ length: 40 }, () => ({
      entityId: 'p-001', quote: 'Sarah Thompson', confidence: 0.9,
    }));
    expect(validateLinks(many, CANDIDATES, TEXT).length).toBeLessThanOrEqual(12);
  });

  it('accepts the good links from a partly-bad response', () => {
    const out = validateLinks(
      [{ entityId: 'nope-999', quote: 'Sarah Thompson', confidence: 1 },
       { entityId: 'proj-rag', quote: 'RAG Platform rewrite', confidence: 0.9 },
       { entityId: 'p-001', quote: 'a quote that is not present', confidence: 0.9 }],
      CANDIDATES, TEXT,
    );
    expect(out.map((l) => l.entityId)).toEqual(['proj-rag']);
  });
});
