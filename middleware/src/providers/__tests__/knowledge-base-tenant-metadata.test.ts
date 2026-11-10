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
const mockFlag = { aurora: false };
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    get mock() { return { agentcore: false, aurora: mockFlag.aurora }; },
    foundation: { documentsBucket: 'docs-bucket' },
    aurora: {},
  },
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
import { landingZoneObjects } from '../../mock/landing-zone.js';

beforeEach(() => { mockFlag.aurora = false; mockS3Send.mockReset(); mockS3Send.mockResolvedValue({}); });

const sent = () => mockS3Send.mock.calls.map(([cmd]) => ({ op: cmd.constructor.name as string, ...(cmd.input as { Key: string; Body: unknown; ContentType?: string }) }));
const puts = () => sent().filter((c) => c.op === 'PutObjectCommand');

it('writes the tenant the route resolved as the document metadata', async () => {
  const out = await uploadDocument('notes.md', Buffer.from('hello'), 'text/markdown', 'assessment/evidence', 'assessment');
  const [sidecar, doc] = puts();
  expect(doc!.Key).toBe(out.key);
  expect(sidecar!.Key).toBe(`${out.key}.metadata.json`);
  expect(JSON.parse(String(sidecar!.Body))).toEqual({ metadataAttributes: { tenant: 'assessment' } });
});

it('falls back to the declared owner of the prefix', async () => {
  await uploadDocument('a.md', Buffer.from('x'), 'text/markdown');
  expect(JSON.parse(String(puts()[0]!.Body))).toEqual({ metadataAttributes: { tenant: 'orgiq' } });
});

it('writes no sidecar for a key no tenant owns', async () => {
  await uploadDocument('a.md', Buffer.from('x'), 'text/markdown', 'nowhere', null);
  expect(puts()).toHaveLength(1);
});

it('a link upload writes the landing zone\'s tenant as the document metadata', async () => {
  const out = await uploadToLandingZone('assessment-evidence', 'notes.md', Buffer.from('hello'), 'text/markdown');
  const [sidecar, doc] = puts();
  expect(doc!.Key).toBe(out.key);
  expect(sidecar!.Key).toBe(`${out.key}.metadata.json`);
  expect(JSON.parse(String(sidecar!.Body))).toEqual({ metadataAttributes: { tenant: 'assessment' } });
});

it('a link upload names its own KB\'s tenant even when the registry read fails', async () => {
  const { listKbs } = jest.requireMock('../kb-registry.js') as { listKbs: jest.Mock };
  listKbs.mockRejectedValueOnce(new Error('aurora down'));
  await uploadToLandingZone('loose', 'a.md', Buffer.from('x'), 'text/markdown');
  expect(JSON.parse(String(puts()[0]!.Body))).toEqual({ metadataAttributes: { tenant: 'orgiq' } });
});

describe('a name that would land on a metadata sidecar key', () => {
  it.each(['notes.md.metadata.json', 'Notes.MD.Metadata.Json', 'dir/x.pdf.metadata.json', 'x.metadata.json'])(
    'is refused by both providers before any write: %s',
    async (name) => {
      await expect(uploadDocument(name, Buffer.from('{}'), 'application/json')).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(/reserved for document metadata/),
      });
      await expect(uploadToLandingZone('orgiq-uploads', name, Buffer.from('{}'), 'application/json')).rejects.toMatchObject({
        status: 400, message: expect.stringMatching(/reserved for document metadata/),
      });
      expect(mockS3Send).not.toHaveBeenCalled();
    },
  );

  it('an ordinary .json document still uploads', async () => {
    await uploadDocument('export.json', Buffer.from('{}'), 'application/json');
    await uploadToLandingZone('orgiq-uploads', 'metadata.json', Buffer.from('{}'), 'application/json');
    expect(puts().filter((p) => !p.Key.endsWith('.metadata.json')).map((p) => p.Key))
      .toEqual([expect.stringMatching(/\/export\.json$/), expect.stringMatching(/\/metadata\.json$/)]);
  });
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
    expect(byLink[1]!.Key).toBe(byFile[1]!.Key);
    expect(byLink[0]).toEqual(byFile[0]);
  });
});

describe('the sidecar is written before the object, so no object is ever unlabelled', () => {
  const uploads: Array<[string, () => Promise<unknown>]> = [
    ['file upload', () => uploadDocument('notes.md', Buffer.from('x'), 'text/markdown', 'assessment/evidence')],
    ['link upload', () => uploadToLandingZone('assessment-evidence', 'notes.md', Buffer.from('x'), 'text/markdown')],
  ];

  it.each(uploads)('%s: sidecar first, then the object', async (_name, upload) => {
    await upload();
    const ops = sent();
    expect(ops.map((o) => o.op)).toEqual(['PutObjectCommand', 'PutObjectCommand']);
    expect(ops[0]!.Key.endsWith('.metadata.json')).toBe(true);
    expect(ops[1]!.Key).toBe(ops[0]!.Key.slice(0, -'.metadata.json'.length));
  });

  it.each(uploads)('%s: a failed sidecar put writes no object', async (_name, upload) => {
    mockS3Send.mockRejectedValueOnce(new Error('sidecar put failed'));
    await expect(upload()).rejects.toThrow('sidecar put failed');
    expect(sent()).toHaveLength(1);
  });

  it.each(uploads)('%s: a failed object put removes the new sidecar when no object is at the key', async (_name, upload) => {
    mockS3Send
      .mockResolvedValueOnce({})                                         // sidecar
      .mockRejectedValueOnce(new Error('object put failed'))              // object
      .mockRejectedValueOnce(Object.assign(new Error('nf'), { name: 'NotFound' })); // head
    await expect(upload()).rejects.toThrow('object put failed');
    const ops = sent();
    expect(ops.map((o) => o.op)).toEqual(['PutObjectCommand', 'PutObjectCommand', 'HeadObjectCommand', 'DeleteObjectCommand']);
    expect(ops[3]!.Key).toBe(ops[0]!.Key);
  });

  it.each(uploads)('%s: a failed re-upload keeps the label of the version still there', async (_name, upload) => {
    mockS3Send
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('object put failed'))
      .mockResolvedValueOnce({ ContentLength: 1 });                       // head: an object exists
    await expect(upload()).rejects.toThrow('object put failed');
    expect(sent().map((o) => o.op)).toEqual(['PutObjectCommand', 'PutObjectCommand', 'HeadObjectCommand']);
  });
});

describe('parity: the offline landing zone writes what S3 would', () => {
  beforeEach(() => landingZoneObjects.reset());

  it('the mock branch lands the same sidecar and object, sidecar first', async () => {
    await uploadToLandingZone('assessment-evidence', 'same.md', Buffer.from('hello'), 'text/markdown');
    const real = puts().map((p) => ({ key: p.Key, contentType: p.ContentType }));
    mockS3Send.mockClear();

    mockFlag.aurora = true;
    const before = landingZoneObjects.rows().length;
    const out = await uploadToLandingZone('assessment-evidence', 'same.md', Buffer.from('hello'), 'text/markdown');
    expect(mockS3Send).not.toHaveBeenCalled();
    const landed = landingZoneObjects.rows().slice(before).map((o) => ({ key: o.key, contentType: o.contentType }));
    expect(landed).toEqual(real);
    expect(landed[1]!.key).toBe(out.key);
  });

  it('the mock branch labels a key only its own KB entry owns, as the real branch does', async () => {
    mockFlag.aurora = true;
    const before = landingZoneObjects.rows().length;
    await uploadToLandingZone('loose', 'a.md', Buffer.from('x'), 'text/markdown');
    // `loose` is in no registry listing, but its own entry names a tenant.
    expect(landingZoneObjects.rows().slice(before).map((o) => o.key.endsWith('.metadata.json'))).toEqual([true, false]);
  });
});
