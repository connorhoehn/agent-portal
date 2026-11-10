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
//   deleteFromLandingZone — delete a specific object and its metadata sidecar (with prefix-guard)

import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config.js';
import { getKbBySlug, listKbs } from './kb-registry.js';
import { ownerOfKey, reservedUploadName, safeUploadName, tenantMetadataSidecar } from '../lib/kb-prefixes.js';
import { ValidationError } from '../lib/async-handler.js';
import { deleteDocumentWithSidecar, putDocumentWithSidecar, sidecarKeyFor } from '../lib/kb-document-put.js';
import { clock } from '../mock/core/clock.js';
import {
  MOCK_DOCUMENTS_BUCKET,
  bytesUnder,
  deleteObject,
  objectsUnder,
  putObject,
} from '../mock/landing-zone.js';

/**
 * The bucket these five functions read and write.
 *
 * Offline it is the fixture in `mock/landing-zone.ts`, and the name is
 * returned rather than `''` on purpose: `getLandingZoneStats` reports `bucket`
 * to the UI, and an empty string there is how "DOCUMENTS_BUCKET is not
 * configured" used to render identically to "this prefix has no objects".
 */
function documentsBucket(): string {
  return config.mock.aurora ? MOCK_DOCUMENTS_BUCKET : config.foundation.documentsBucket;
}

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
  if (config.mock.aurora) {
    // Every number here is counted from the fixture rows, never stored beside
    // them — the same reason `byExtension` is built from the listing below
    // rather than written down (contract.ts rule 1).
    const objects = objectsUnder(prefix);
    const extMap = new Map<string, { count: number; bytes: number }>();
    for (const o of objects) {
      const ext = fileExtension(o.key) || '(none)';
      const slot = extMap.get(ext) ?? { count: 0, bytes: 0 };
      slot.count++;
      slot.bytes += o.size;
      extMap.set(ext, slot);
    }
    const newest = objects[0] ?? null;
    return {
      bucket: MOCK_DOCUMENTS_BUCKET,
      prefix,
      objectCount: objects.length,
      totalBytes: bytesUnder(prefix),
      byExtension: Array.from(extMap.entries())
        .map(([extension, v]) => ({ extension, ...v }))
        .sort((a, b) => b.bytes - a.bytes),
      newestKey: newest?.key ?? null,
      newestAt: newest?.lastModified ?? null,
    };
  }

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
  if (config.mock.aurora) {
    // `.keep` is filtered here exactly as it is on the real path — the marker
    // is provisioning bookkeeping, not a document someone dropped.
    const files: LandingZoneFile[] = objectsUnder(prefix)
      .filter((o) => !o.key.slice(prefix.length).endsWith('.keep'))
      .slice(0, opts.limit ?? 50)
      .map((o) => ({
        key: o.key,
        size: o.size,
        lastModified: o.lastModified,
        extension: fileExtension(o.key) || '(none)',
      }));
    // One page: the fixture is smaller than any limit a caller can ask for, so
    // claiming a continuation token would name a page that does not exist.
    return { files, nextToken: null, prefix };
  }

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
 *
 * Writes the same tenant metadata sidecar as the file upload
 * (knowledge-base.ts `uploadDocument`): retrieval filters on it beside the key
 * prefix, so a document landed by an upload link without one would be
 * invisible to its own tenant until a backfill. The owner is the key's
 * longest registered or declared prefix (the agents' rule), with this KB's
 * entry always among the registered ones.
 */
export async function uploadToLandingZone(
  kbSlug: string,
  filename: string,
  body: Buffer,
  contentType: string,
): Promise<LandingZoneUploadResult> {
  // A name ending `.metadata.json` would land on another object's metadata
  // sidecar key; refused here as well as at each route that calls this.
  const reserved = reservedUploadName(filename);
  if (reserved) throw new ValidationError(reserved);

  const entry = await getKbBySlug(kbSlug);
  if (!entry) throw new Error(`KB not found: ${kbSlug}`);

  const bucket = documentsBucket();
  if (!bucket) throw new Error('DOCUMENTS_BUCKET not configured');

  const prefix = entry.s3Prefix.endsWith('/') ? entry.s3Prefix : `${entry.s3Prefix}/`;
  // Through the clock, not `new Date()`: this is the date segment the key is
  // filed under, so a frozen-clock test asserts the exact key, and a mint here
  // is the provider-mock-branch bug scripts/validate-mock-floor.sh rule 3 was
  // widened to catch.
  const now = clock.nowIso();
  const date = now.slice(0, 10);
  const safeFilename = safeUploadName(filename);
  const key = `${prefix}${date}/${safeFilename}`;

  const registered = await listKbs().catch(() => []);
  const owner = ownerOfKey(key, [{ tenant: entry.tenant, s3Prefix: entry.s3Prefix }, ...registered]);

  if (config.mock.aurora) {
    // The object really lands — in the fixture bucket, where the file browser
    // that reads it offline will list it and `POST /api/__mock/reset` will
    // take it away again. Its sidecar lands first, as on the real path
    // (lib/kb-document-put.ts), so the offline bucket holds what S3 would.
    if (owner) {
      const sidecar = tenantMetadataSidecar(key, owner);
      putObject({ key: sidecar.key, size: Buffer.byteLength(sidecar.body), lastModified: now, contentType: 'application/json' });
    }
    putObject({ key, size: body.length, lastModified: now, contentType });
    return { key, bucket, size: body.length, contentType, s3Uri: `s3://${bucket}/${key}` };
  }

  // Sidecar first, then the object: never an object readable without its
  // tenant label (lib/kb-document-put.ts).
  await putDocumentWithSidecar(s3Client(), {
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
    Metadata: {
      'kb-slug': kbSlug,
      'uploaded-at': now,
      'original-name': filename.slice(0, 512),
    },
  }, owner);

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
  const bucket = documentsBucket();
  if (!bucket) throw new Error('DOCUMENTS_BUCKET not configured');

  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;

  if (config.mock.aurora) {
    putObject({
      key: `${normalizedPrefix}.keep`,
      size: 0,
      lastModified: clock.nowIso(),
      contentType: 'application/octet-stream',
    });
    return;
  }

  const s3 = s3Client();
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
 * Delete a specific object from the landing zone, and its tenant metadata
 * sidecar after it.
 * Throws if the key does not start with the expected prefix (security guard).
 */
export async function deleteFromLandingZone(prefix: string, key: string): Promise<void> {
  const normalizedPrefix = prefix.endsWith('/') ? prefix : `${prefix}/`;
  if (!key.startsWith(normalizedPrefix)) {
    throw new Error(
      `Key "${key}" does not belong to prefix "${normalizedPrefix}" — deletion refused`,
    );
  }

  const bucket = documentsBucket();
  if (!bucket) throw new Error('DOCUMENTS_BUCKET not configured');

  // The sidecar goes with the object, object first (lib/kb-document-put.ts).
  if (config.mock.aurora) {
    deleteObject(key);
    const sidecar = sidecarKeyFor(key);
    if (sidecar) deleteObject(sidecar);
    return;
  }

  await deleteDocumentWithSidecar(s3Client(), bucket, key);
}
