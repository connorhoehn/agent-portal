// Landing-zone provider — S3 operations scoped to a KB's s3Prefix.
//
// Each Knowledge Base in the registry has a dedicated S3 prefix (its "landing zone").
// Documents uploaded here are picked up by Bedrock KB ingestion jobs.
//
// Functions:
//   getLandingZoneStats  — aggregate S3 stats for a prefix (up to 5 000 objects)
//   listLandingZoneFiles — paginated file list for a prefix
//   uploadToLandingZone  — upload a file under the KB's prefix
//   initLandingZone      — create a .keep marker so the prefix exists in S3
//   deleteFromLandingZone — delete a specific object (with prefix-guard)

import { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { basename } from 'node:path';
import { config } from '../config.js';
import { getKbBySlug } from './kb-registry.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LandingZoneStats {
  bucket: string;
  prefix: string;
  objectCount: number;
  totalBytes: number;
  byExtension: Array<{ extension: string; count: number; bytes: number }>;
  newestKey: string | null;
  newestAt: string | null;
}

export interface LandingZoneFile {
  key: string;
  size: number;
  lastModified: string;
  extension: string;
}

export interface LandingZonePage {
  files: LandingZoneFile[];
  nextToken: string | null;
  prefix: string;
}

export interface LandingZoneUploadResult {
  key: string;
  bucket: string;
  size: number;
  contentType: string;
  s3Uri: string;
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function s3Client(): S3Client {
  return new S3Client({ region: config.region });
}

function fileExtension(key: string): string {
  const dot = key.lastIndexOf('.');
  if (dot < 0 || dot === key.length - 1) return '';
  return key.slice(dot).toLowerCase();
}

// ─── getLandingZoneStats ───────────────────────────────────────────────────────

/**
 * Aggregate S3 stats for a given prefix.  Paginates up to 5 000 objects.
 * Returns zeroed stats (bucket = '') when the documents bucket is not configured.
 */
export async function getLandingZoneStats(prefix: string): Promise<LandingZoneStats> {
  const bucket = config.foundation.documentsBucket;
  if (!bucket) {
    return {
      bucket: '',
      prefix,
      objectCount: 0,
      totalBytes: 0,
      byExtension: [],
      newestKey: null,
      newestAt: null,
    };
  }

  const s3 = s3Client();
  let continuationToken: string | undefined;
  let objectCount = 0;
  let totalBytes = 0;
  const extMap = new Map<string, { count: number; bytes: number }>();
  let newestKey: string | null = null;
  let newestAt: Date | null = null;

  for (let page = 0; page < 50; page++) {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        MaxKeys: 100,
        ...(continuationToken ? { ContinuationToken: continuationToken } : {}),
      }),
    );

    for (const obj of resp.Contents ?? []) {
      if (!obj.Key) continue;
      objectCount++;
      const size = obj.Size ?? 0;
      totalBytes += size;

      const ext = fileExtension(obj.Key) || '(none)';
      const slot = extMap.get(ext) ?? { count: 0, bytes: 0 };
      slot.count++;
      slot.bytes += size;
      extMap.set(ext, slot);

      if (obj.LastModified && (newestAt === null || obj.LastModified > newestAt)) {
        newestAt = obj.LastModified;
        newestKey = obj.Key;
      }
    }

    if (!resp.IsTruncated || !resp.NextContinuationToken) break;
    continuationToken = resp.NextContinuationToken;
  }

  const byExtension = Array.from(extMap.entries())
    .map(([extension, v]) => ({ extension, ...v }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    bucket,
    prefix,
    objectCount,
    totalBytes,
    byExtension,
    newestKey,
    newestAt: newestAt ? newestAt.toISOString() : null,
  };
}

// ─── listLandingZoneFiles ─────────────────────────────────────────────────────

/**
 * Return a page of files under the given prefix.
 * `.keep` marker files are filtered out of the returned list.
 */
export async function listLandingZoneFiles(
  prefix: string,
  opts: { limit?: number; continuationToken?: string } = {},
): Promise<LandingZonePage> {
  const bucket = config.foundation.documentsBucket;
  if (!bucket) {
    return { files: [], nextToken: null, prefix };
  }

  const s3 = s3Client();
  const resp = await s3.send(
    new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      MaxKeys: opts.limit ?? 50,
      ...(opts.continuationToken ? { ContinuationToken: opts.continuationToken } : {}),
    }),
  );

  const files: LandingZoneFile[] = (resp.Contents ?? [])
    .filter((obj) => {
      if (!obj.Key) return false;
      // Strip the prefix to get the relative key segment and exclude .keep markers.
      const rel = obj.Key.slice(prefix.length);
      return !rel.endsWith('.keep');
    })
    .map((obj) => ({
      key: obj.Key!,
      size: obj.Size ?? 0,
      lastModified: obj.LastModified ? obj.LastModified.toISOString() : '',
      extension: fileExtension(obj.Key!) || '(none)',
    }));

  return {
    files,
    nextToken: resp.NextContinuationToken ?? null,
    prefix,
  };
}

// ─── uploadToLandingZone ──────────────────────────────────────────────────────

/**
 * Upload a file into the landing zone for the given KB slug.
 * Resolves the s3Prefix from the registry and throws if the KB is not found.
 */
export async function uploadToLandingZone(
  kbSlug: string,
  filename: string,
  body: Buffer,
  contentType: string,
): Promise<LandingZoneUploadResult> {
  const entry = await getKbBySlug(kbSlug);
  if (!entry) throw new Error(`KB not found: ${kbSlug}`);

  const bucket = config.foundation.documentsBucket;
  if (!bucket) throw new Error('DOCUMENTS_BUCKET not configured');

  const s3 = s3Client();
  const prefix = entry.s3Prefix.endsWith('/') ? entry.s3Prefix : `${entry.s3Prefix}/`;
  const date = new Date().toISOString().slice(0, 10);
  const safeFilename = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `${prefix}${date}/${safeFilename}`;
  const now = new Date().toISOString();

  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      Metadata: {
        'kb-slug': kbSlug,
        'uploaded-at': now,
        'original-name': filename.slice(0, 512),
      },
    }),
  );

  return {
    key,
    bucket,
    size: body.length,
    contentType,
    s3Uri: `s3://${bucket}/${key}`,
  };
}

// ─── initLandingZone ──────────────────────────────────────────────────────────

/**
 * Place a zero-byte `.keep` marker at the given prefix so the prefix is
 * visible in the S3 console and the KB data source can reference it.
 */
export async function initLandingZone(prefix: string): Promise<void> {
  const bucket = config.foundation.documentsBucket;
  if (!bucket) throw new Error('DOCUMENTS_BUCKET not configured');

  const s3 = s3Client();
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `${normalizedPrefix}.keep`,
      Body: Buffer.alloc(0),
      ContentType: 'application/octet-stream',
      Metadata: {
        'created-at': new Date().toISOString(),
        'purpose': 'landing-zone-marker',
      },
    }),
  );
}

// ─── deleteFromLandingZone ────────────────────────────────────────────────────

/**
 * Delete a specific object from the landing zone.
 * Throws if the key does not start with the expected prefix (security guard).
 */
export async function deleteFromLandingZone(prefix: string, key: string): Promise<void> {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  if (!key.startsWith(normalizedPrefix)) {
    throw new Error(
      `Key "${key}" does not belong to prefix "${normalizedPrefix}" — deletion refused`,
    );
  }

  const bucket = config.foundation.documentsBucket;
  if (!bucket) throw new Error('DOCUMENTS_BUCKET not configured');

  const s3 = s3Client();
  await s3.send(
    new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }),
  );
}
