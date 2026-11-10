// An upload writes the document and, beside it, the Bedrock metadata sidecar
// naming its owning tenant (retrieval filters on it, beside the key prefix).
const mockS3Send = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  ...jest.requireActual('@aws-sdk/client-s3'),
  S3Client: jest.fn(() => ({ send: mockS3Send })),
}));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { agentcore: false, aurora: false }, foundation: { documentsBucket: 'docs-bucket' }, aurora: {} },
}));
import { uploadDocument } from '../knowledge-base.js';

beforeEach(() => { mockS3Send.mockReset(); mockS3Send.mockResolvedValue({}); });

const puts = () => mockS3Send.mock.calls.map(([cmd]) => cmd.input as { Key: string; Body: unknown });

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
