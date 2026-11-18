// Where the résumé bytes live (row I1.6): one small interface, three implementations.
//
//   memory        under the mock providers (dev:mock, the journeys, tests). A seeded key answers from the seed
//                 (mock/interviews-resumes.ts), so a reset restores the seeded files without any state here.
//   S3            when INTERVIEWS_RESUME_BUCKET names a bucket. Objects are private: no ACL, no public or
//                 presigned URL ever; the only reader is the server, through GET .../resume/file.
//   unavailable   neither: an upload is refused with one plain sentence and a read finds nothing.

import { config } from '../../../config.js';
import { seededResumeBytes } from '../../../mock/interviews-resumes.js';

export interface ResumeBytesStore {
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  remove(key: string): Promise<void>;
}

export const NO_STORAGE_SENTENCE = 'Résumés cannot be stored here yet, so this file was not saved.';

/** Thrown by `put` when no storage is set up. The route answers it with NO_STORAGE_SENTENCE. */
export class ResumeStorageUnavailableError extends Error {
  constructor() { super(NO_STORAGE_SENTENCE); this.name = 'ResumeStorageUnavailableError'; }
}

export class MemoryResumeBytes implements ResumeBytesStore {
  private readonly held = new Map<string, Buffer>();
  /** Seeded files that were removed (row I6.3): the seed builds them from the key, so a removal has to be remembered. */
  private readonly removed = new Set<string>();
  async put(key: string, bytes: Buffer): Promise<void> { this.removed.delete(key); this.held.set(key, Buffer.from(bytes)); }
  async get(key: string): Promise<Buffer | null> {
    if (this.removed.has(key)) return null;
    const held = this.held.get(key) ?? seededResumeBytes(key);
    return held ? Buffer.from(held) : null;
  }
  async remove(key: string): Promise<void> { this.held.delete(key); this.removed.add(key); }
  /** A mock reset: the seeded files come back and uploads go (the rows are reset with the fixtures). */
  reset(): void { this.held.clear(); this.removed.clear(); }
}

export class UnavailableResumeBytes implements ResumeBytesStore {
  async put(): Promise<void> { throw new ResumeStorageUnavailableError(); }
  async get(): Promise<Buffer | null> { return null; }
  async remove(): Promise<void> { /* nothing was ever stored */ }
}

/** The slice of the S3 client this store uses, so a test can hand in a fake. */
export interface S3Like { send(command: unknown): Promise<unknown> }

export class S3ResumeBytes implements ResumeBytesStore {
  constructor(private readonly bucket: string, private readonly client: () => Promise<S3Like>) {}

  async put(key: string, bytes: Buffer): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.client()).send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: bytes, ContentType: 'application/pdf', ServerSideEncryption: 'AES256', CacheControl: 'private, no-store',
    }));
  }

  async get(key: string): Promise<Buffer | null> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    try {
      const out = await (await this.client()).send(new GetObjectCommand({ Bucket: this.bucket, Key: key })) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      return out.Body ? Buffer.from(await out.Body.transformToByteArray()) : null;
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
  }

  async remove(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    await (await this.client()).send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** The one setting: the bucket that holds résumés. */
export const RESUME_BUCKET_SETTING = 'INTERVIEWS_RESUME_BUCKET';

export function createResumeBytes(env: NodeJS.ProcessEnv = process.env): ResumeBytesStore {
  if (config.mock?.aurora) return new MemoryResumeBytes();
  const bucket = String(env[RESUME_BUCKET_SETTING] ?? '').trim();
  if (!bucket) return new UnavailableResumeBytes();
  let client: S3Like | null = null;
  return new S3ResumeBytes(bucket, async () => {
    if (client) return client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    return (client = new S3Client({ region: config.region }) as unknown as S3Like);
  });
}
