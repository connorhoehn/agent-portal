// An upload writes the document and, beside it, the Bedrock metadata sidecar
// naming its owning tenant (retrieval filters on it, beside the key prefix).
// Both ways a document reaches the bucket are held to it: the file upload
// (knowledge-base.ts `uploadDocument`) and the upload link's landing-zone
// write (landing-zones.ts `uploadToLandingZone`), which used to write none.
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual('@aws-sdk/client-s3'),
  S3Client: jest.fn(() => ({ send: mockS3Send })),
}));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { agentcore: false, aurora: false }, foundation: { documentsBucket: 'docs-bucket' }, aurora: {} },
}));
const mockKbs = [
  { slug: 'assessment-evidence', tenant: 'assessment', s3Prefix: 'assessment/evidence' },
  { slug: 'orgiq-uploads', tenant: 'orgiq', s3Prefix: 'uploads/' },
  { slug: 'loose', tenant: 'orgiq', s3Prefix: 'nowhere/' },
];
jest.mock('../kb-registry.js', () => ({
  getKbBySlug: jest.fn(async (slug: string) => mockKbs.find((k) => k.slug === slug) ?? null),
  listKbs: jest.fn(async () => mockKbs.filter((k) => k.slug !== 'loose')),
}));
import { uploadDocument } from '../knowledge-base.js';
import { uploadToLandingZone } from '../landing-zones.js';

beforeEach(() => { mockS3Send.mockReset(); mockS3Send.mockResolvedValue({}); });

const puts = () => mockS3Send.mock.calls.map(([cmd]) => cmd.input as { Key: string; Body: unknown; ContentType?: string });

it('writes the tenant the route resolved as the document metadata', async () => {
  const out = await uploadDocument('notes.md', Buffer.from('hello'), 'text/markdown', 'assessment/evidence', 'assessment');
  const [doc, sidecar] = puts();
  expect(doc!.Key).toBe(out.key);
  expect(sidecar!.Key).toBe(`${out.key}.metadata.json`);
  expect(JSON.parse(String(sidecar!.Body))).toEqual({ metadataAttributes: { tenant: 'assessment' } });
});

it('falls back to the declared owner of the prefix', async () => {
  await uploadDocument('a.md', Buffer.from('x'), 'text/markdown');
  expect(JSON.parse(String(puts()[1]!.Body))).toEqual({ metadataAttributes: { tenant: 'orgiq' } });
});

it('writes no sidecar for a key no tenant owns', async () => {
  await uploadDocument('a.md', Buffer.from('x'), 'text/markdown', 'nowhere', null);
  expect(puts()).toHaveLength(1);
});

it('a link upload writes the landing zone\'s tenant as the document metadata', async () => {
  const out = await uploadToLandingZone('assessment-evidence', 'notes.md', Buffer.from('hello'), 'text/markdown');
  const [doc, sidecar] = puts();
  expect(doc!.Key).toBe(out.key);
  expect(sidecar!.Key).toBe(`${out.key}.metadata.json`);
  expect(JSON.parse(String(sidecar!.Body))).toEqual({ metadataAttributes: { tenant: 'assessment' } });
});

it('a link upload names its own KB\'s tenant even when the registry read fails', async () => {
  const { listKbs } = jest.requireMock('../kb-registry.js') as { listKbs: jest.Mock };
  listKbs.mockRejectedValueOnce(new Error('aurora down'));
  await uploadToLandingZone('loose', 'a.md', Buffer.from('x'), 'text/markdown');
  expect(JSON.parse(String(puts()[1]!.Body))).toEqual({ metadataAttributes: { tenant: 'orgiq' } });
});

describe('parity: a file upload and a link upload of the same document', () => {
  it.each([
    ['assessment', 'assessment/evidence', 'assessment-evidence'],
    ['orgiq', 'uploads', 'orgiq-uploads'],
  ])('write the same document key and the same %s sidecar', async (_tenant, prefix, slug) => {
    await uploadDocument('same.md', Buffer.from('x'), 'text/markdown', prefix);
    const byFile = puts();
    mockS3Send.mockClear();
    await uploadToLandingZone(slug, 'same.md', Buffer.from('x'), 'text/markdown');
    const byLink = puts();
    expect(byLink).toHaveLength(2);
    expect(byFile).toHaveLength(2);
    expect(byLink[0]!.Key).toBe(byFile[0]!.Key);
    expect(byLink[1]).toEqual(byFile[1]);
  });
});
