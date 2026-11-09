// Citation annotation tests.
//
// This layer has one job — turn the s3:// key in a retrieval result into the
// document's title — and two obligations while doing it: never change a
// payload it does not understand, and never let an Aurora problem break a live
// stream. Both are asserted here, because a mistake in either is invisible in
// the UI (a slightly worse chip, or a turn that dies mid-answer).

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({ config: { mock: { aurora: false } } }));

import { exec } from '../../providers/aurora.js';
import {
  annotateTitles,
  annotateToolResult,
  isRetrievalTool,
  retrievalUris,
  rewrapJson,
  unwrapJson,
  _resetTitleCache,
} from '../answer-sources.js';

const execMock = exec as jest.MockedFunction<typeof exec>;

const S3 = 's3://orgiq-documents-123456789012-us-east-1/perf/perf-theo.txt';
const TITLE = 'Performance review — Theo Williams';

/** What the AG-UI adapter actually puts on the wire: a JSON string of a JSON string. */
const doubleEncoded = (obj: unknown): string => JSON.stringify(JSON.stringify(obj));

beforeEach(() => {
  execMock.mockReset();
  _resetTitleCache();
});

describe('payload shapes', () => {
  it('peels the adapter double-encoding and puts it back exactly', () => {
    const raw = doubleEncoded([{ source: S3 }]);
    const { value, depth } = unwrapJson(raw);
    expect(depth).toBe(2);
    expect(value).toEqual([{ source: S3 }]);
    expect(rewrapJson(value, depth)).toBe(raw);
  });

  it('leaves a non-JSON string alone', () => {
    const { value, depth } = unwrapJson('The top 2 Kubernetes experts are: …');
    expect(depth).toBe(0);
    expect(value).toBe('The top 2 Kubernetes experts are: …');
  });

  it('reads document URIs from the tool shape and the Bedrock shape', () => {
    expect(retrievalUris([{ content: '…', score: 0.7, source: S3 }])).toEqual([S3]);
    expect(retrievalUris([{ location: { s3Location: { uri: S3 } } }])).toEqual([S3]);
    expect(retrievalUris({ results: [{ uri: S3 }, { uri: S3 }] })).toEqual([S3]);
    expect(retrievalUris([{ source: 'unknown' }])).toEqual([]);
    expect(retrievalUris('nonsense')).toEqual([]);
  });

  it('returns the same reference when there is no title to add', () => {
    const value = [{ source: S3 }];
    expect(annotateTitles(value, new Map())).toBe(value);
    expect(annotateTitles(value, new Map([['s3://other/x', 'X']]))).toBe(value);
  });
});

describe('annotateToolResult', () => {
  it('adds documents.title to each retrieved item', async () => {
    execMock.mockResolvedValue([{ source_uri: S3, title: TITLE }]);
    const out = await annotateToolResult(
      'query_knowledge_base',
      doubleEncoded([{ content: '…', score: 0.7, source: S3 }]),
    );
    expect(JSON.parse(JSON.parse(String(out)))).toEqual([
      { content: '…', score: 0.7, source: S3, title: TITLE },
    ]);
  });

  it('asks Aurora once per URI, then serves the cache', async () => {
    execMock.mockResolvedValue([{ source_uri: S3, title: TITLE }]);
    const payload = doubleEncoded([{ source: S3 }]);
    await annotateToolResult('query_knowledge_base', payload);
    await annotateToolResult('query_knowledge_base', payload);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('does not re-ask for a URI Aurora has no row for', async () => {
    execMock.mockResolvedValue([]);
    const payload = doubleEncoded([{ source: S3 }]);
    await annotateToolResult('query_knowledge_base', payload);
    await annotateToolResult('query_knowledge_base', payload);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it('costs nothing when the result names no documents — the empty-KB case', async () => {
    const payload = doubleEncoded([]);
    expect(await annotateToolResult('query_knowledge_base', payload)).toBe(payload);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('ignores tools that are not retrieval', async () => {
    const payload = doubleEncoded([{ source: S3 }]);
    expect(await annotateToolResult('get_expertise_scores', payload)).toBe(payload);
    expect(await annotateToolResult('', payload)).toBe(payload);
    expect(execMock).not.toHaveBeenCalled();
  });

  it('forwards the original content when Aurora fails', async () => {
    execMock.mockRejectedValue(new Error('Aurora is resuming'));
    const payload = doubleEncoded([{ source: S3 }]);
    await expect(annotateToolResult('query_knowledge_base', payload)).resolves.toBe(payload);
  });

  it('forwards prose results untouched', async () => {
    const prose = JSON.stringify('The top 2 Kubernetes experts are: …');
    expect(await annotateToolResult('query_knowledge_base', prose)).toBe(prose);
  });
});

describe('isRetrievalTool', () => {
  it('matches the knowledge-base tools and nothing else', () => {
    expect(isRetrievalTool('query_knowledge_base')).toBe(true);
    expect(isRetrievalTool('retrieve_documents')).toBe(true);
    expect(isRetrievalTool('query_graph')).toBe(false);
    expect(isRetrievalTool('search_organization')).toBe(false);
  });
});
