jest.mock('../../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: false } } }));

import { MemoryResumeBytes, ResumeStorageUnavailableError, S3ResumeBytes, UnavailableResumeBytes, createResumeBytes, NO_STORAGE_SENTENCE } from '../bytes-store.js';
import { seededResumeBytes } from '../../../../mock/interviews-resumes.js';
import { isPdfBytes } from '../rules.js';

const PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1');

describe('the memory bytes store', () => {
  it('puts, gets a copy, removes', async () => {
    const s = new MemoryResumeBytes();
    await s.put('k', PDF);
    const got = (await s.get('k'))!;
    expect(got.equals(PDF)).toBe(true);
    got[0] = 0;
    expect((await s.get('k'))!.equals(PDF)).toBe(true);
    await s.remove('k');
    expect(await s.get('k')).toBeNull();
  });

  it('answers a seeded key from the seed, and nothing for an unknown key', async () => {
    const s = new MemoryResumeBytes();
    const key = 'interviews/resumes/cand-rx6tcaqj/rf-rx6tcaqj.pdf';
    expect(isPdfBytes((await s.get(key))!)).toBe(true);
    expect((await s.get(key))!.equals(seededResumeBytes(key)!)).toBe(true);
    expect(await s.get('interviews/resumes/cand-nobody/rf-x.pdf')).toBeNull();
  });
});

describe('with no storage', () => {
  it('refuses an upload with one plain sentence and reads nothing', async () => {
    const s = new UnavailableResumeBytes();
    await expect(s.put()).rejects.toBeInstanceOf(ResumeStorageUnavailableError);
    await expect(s.put()).rejects.toThrow(NO_STORAGE_SENTENCE);
    expect(await s.get()).toBeNull();
    await expect(s.remove()).resolves.toBeUndefined();
  });

  it('is what a real process with no bucket gets; a named bucket gives the S3 store', () => {
    expect(createResumeBytes({})).toBeInstanceOf(UnavailableResumeBytes);
    expect(createResumeBytes({ INTERVIEWS_RESUME_BUCKET: '  ' })).toBeInstanceOf(UnavailableResumeBytes);
    expect(createResumeBytes({ INTERVIEWS_RESUME_BUCKET: 'a-bucket' })).toBeInstanceOf(S3ResumeBytes);
  });
});

describe('the S3 bytes store', () => {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let reply: (name: string) => unknown;
  const client = { send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => { calls.push({ name: c.constructor.name, input: c.input }); return reply(c.constructor.name); } };
  const s3 = new S3ResumeBytes('the-bucket', async () => client);
  beforeEach(() => { calls.length = 0; reply = () => ({}); });

  it('puts privately: no ACL, the PDF type, the key given', async () => {
    await s3.put('interviews/resumes/c/f.pdf', PDF);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.name).toBe('PutObjectCommand');
    expect(calls[0]!.input).toMatchObject({ Bucket: 'the-bucket', Key: 'interviews/resumes/c/f.pdf', ContentType: 'application/pdf' });
    expect(calls[0]!.input).not.toHaveProperty('ACL');
  });

  it('gets the bytes, and a missing object is null', async () => {
    reply = () => ({ Body: { transformToByteArray: async () => new Uint8Array(PDF) } });
    expect((await s3.get('k'))!.equals(PDF)).toBe(true);
    reply = () => { throw Object.assign(new Error('x'), { name: 'NoSuchKey' }); };
    expect(await s3.get('k')).toBeNull();
    reply = () => { throw Object.assign(new Error('x'), { name: 'AccessDenied' }); };
    await expect(s3.get('k')).rejects.toThrow();
  });

  it('removes by key', async () => {
    await s3.remove('k');
    expect(calls[0]).toMatchObject({ name: 'DeleteObjectCommand', input: { Bucket: 'the-bucket', Key: 'k' } });
  });
});

// Hardening (H1, O-028): a round trip against a real bucket. Written, gated, skipped by default: it needs a real S3 bucket
// the caller owns (REAL_RESUME_S3=1 and INTERVIEWS_RESUME_BUCKET set, with AWS credentials in the environment). It writes one
// small object under a throwaway key and removes it.
const realS3 = process.env['REAL_RESUME_S3'] === '1' && !!process.env['INTERVIEWS_RESUME_BUCKET'];
(realS3 ? describe : describe.skip)('the S3 bytes store against a real bucket (REAL_RESUME_S3=1)', () => {
  it('puts, gets the same bytes, and removes: a second get finds nothing', async () => {
    const { S3Client } = await import('@aws-sdk/client-s3');
    const store = new S3ResumeBytes(String(process.env['INTERVIEWS_RESUME_BUCKET']), async () => new S3Client({ region: process.env['AWS_REGION'] ?? 'us-east-1' }) as never);
    const key = `interviews/resumes/h1-roundtrip/${Date.now()}.pdf`;
    await store.put(key, PDF);
    expect((await store.get(key))?.equals(PDF)).toBe(true);
    await store.remove(key);
    expect(await store.get(key)).toBeNull();
  });
});
