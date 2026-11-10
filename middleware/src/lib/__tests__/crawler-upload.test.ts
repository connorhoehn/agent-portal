// A crawled page's indexed documents (markdown, analysis) are written the way
// the two upload paths write theirs (lib/kb-document-put.ts): the tenant
// metadata sidecar first, then the document, so a crawled page is never
// readable without its label. The screenshot is not indexed and has none.
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { agentcore: true, aurora: true },
    foundation: { documentsBucket: 'docs-bucket' },
    aurora: {},
  },
}));
import { uploadArtifacts } from '../crawler.js';
import type { CrawlPage, CrawlSession } from '../crawler.js';

const send = jest.fn();
const s3 = { send } as never;

function fixtures() {
  const crawl = { id: 'c1', s3Prefix: 'crawled/c1', pages: [], totalScreenshotBytes: 0, totalMarkdownBytes: 0 } as unknown as CrawlSession;
  const page = { url: 'https://example.com/a', depth: 0, crawledAt: '2026-01-01T00:00:00.000Z' } as unknown as CrawlPage;
  const vision = { title: 'A', summary: 's', mainText: 'm', discoveredLinks: [], tokensIn: 1, tokensOut: 1, latencyMs: 1 };
  return { crawl, page, vision };
}

const sent = () => send.mock.calls.map(([cmd]) => ({ op: cmd.constructor.name as string, key: (cmd.input as { Key: string }).Key }));

beforeEach(() => { send.mockReset(); send.mockResolvedValue({}); });

it('puts each indexed document\'s sidecar before the document', async () => {
  const { crawl, page, vision } = fixtures();
  await uploadArtifacts(crawl, page, Buffer.from('png'), vision, s3, 'docs-bucket');
  const keys = sent().map((c) => c.key);
  for (const doc of [page.s3MarkdownKey!, page.s3AnalysisKey!]) {
    expect(doc).toBeTruthy();
    const sidecarAt = keys.indexOf(`${doc}.metadata.json`);
    expect(sidecarAt).toBeGreaterThanOrEqual(0);
    expect(sidecarAt).toBeLessThan(keys.indexOf(doc));
  }
  const sidecar = send.mock.calls.map(([c]) => c.input).find((i) => i.Key === `${page.s3MarkdownKey}.metadata.json`);
  expect(JSON.parse(String(sidecar.Body))).toEqual({ metadataAttributes: { tenant: 'orgiq' } });
  expect(keys.filter((k) => k.endsWith('.png.metadata.json'))).toEqual([]);
});

it('a failed sidecar put writes no document and leaves the page without that key', async () => {
  const { crawl, page, vision } = fixtures();
  send.mockImplementation(async (cmd) => {
    if (String(cmd.input.Key).endsWith('.md.metadata.json')) throw new Error('sidecar put failed');
    return {};
  });
  await uploadArtifacts(crawl, page, Buffer.from('png'), vision, s3, 'docs-bucket');
  expect(sent().some((c) => c.key.endsWith('.md'))).toBe(false);
  expect(page.s3MarkdownKey).toBeUndefined();
  expect(page.s3AnalysisKey).toBeTruthy();
});

it('a failed document put removes its new sidecar when nothing is at the key', async () => {
  const { crawl, page, vision } = fixtures();
  send.mockImplementation(async (cmd) => {
    const key = String(cmd.input.Key);
    if (cmd.constructor.name === 'PutObjectCommand' && key.endsWith('.md')) throw new Error('object put failed');
    if (cmd.constructor.name === 'HeadObjectCommand') throw Object.assign(new Error('nf'), { name: 'NotFound' });
    return {};
  });
  await uploadArtifacts(crawl, page, Buffer.from('png'), vision, s3, 'docs-bucket');
  const md = sent().find((c) => c.op === 'PutObjectCommand' && c.key.endsWith('.md'))!.key;
  expect(sent()).toContainEqual({ op: 'DeleteObjectCommand', key: `${md}.metadata.json` });
  expect(page.s3MarkdownKey).toBeUndefined();
});
