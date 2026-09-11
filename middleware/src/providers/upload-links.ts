// Upload links — token-scoped document drops into a knowledge base.
//
// The point is that the recipient gets a URL and nothing else. No AWS
// credential leaves this process: every upload is validated here (link live,
// under quota, allowed type, under size) and then written to S3 by the
// middleware's own identity. That is what makes a leaked link survivable —
// the bounds are columns in a table, not a policy document someone has to get
// right, and revoking is an UPDATE rather than a role rotation.

import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { exec } from './aurora.js';
import { uploadToLandingZone } from './landing-zones.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';
import { config } from '../config.js';
import { clock } from '../mock/core/clock.js';
import {
  claimUploadSlot,
  filesForLink,
  findLinkByTokenHash,
  insertLink,
  linksForKb,
  recordLinkFile,
  releaseUploadSlot,
  revokeLink,
  type MockUploadLink,
} from '../mock/upload-links.js';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function n(name: string, value: number): SqlParameter { return { name, value: { longValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }
function toNum(v: unknown): number { return typeof v === 'number' ? v : Number(v ?? 0); }

/** Extensions Bedrock can actually index. Anything else is refused up front. */
const ALLOWED_EXTENSIONS = new Set([
  '.pdf', '.txt', '.md', '.markdown', '.html', '.htm',
  '.doc', '.docx', '.csv', '.xls', '.xlsx', '.json',
]);

/** Hard ceiling regardless of what a link asks for. */
const ABSOLUTE_MAX_BYTES = 50 * 1024 * 1024;

export interface UploadLink {
  id: string;
  kbSlug: string;
  label: string;
  createdBy: string | null;
  expiresAt: string;
  revokedAt: string | null;
  maxFiles: number;
  maxBytes: number;
  filesUsed: number;
  bytesUsed: number;
  createdAt: string;
  lastUsedAt: string | null;
  /** Derived, so a UI does not re-implement the same three comparisons. */
  status: 'live' | 'expired' | 'revoked' | 'exhausted';
}

/**
 * `now` through the clock rather than `Date.now()`.
 *
 * `clock.now()` IS `Date.now()` unless a test froze it, so nothing changes in
 * production. What it buys is that the offline path is coherent with itself: a
 * link whose `expires_at` was derived from a frozen clock has to be judged
 * against the same instant, or a link minted "48 hours from now" in a test
 * reads as already expired. That is not hypothetical — it is what this
 * function did until the frozen-clock test below caught it.
 */
function statusOf(row: {
  revokedAt: string | null; expiresAt: string; filesUsed: number; maxFiles: number;
}): UploadLink['status'] {
  if (row.revokedAt) return 'revoked';
  if (new Date(row.expiresAt).getTime() <= clock.now().getTime()) return 'expired';
  if (row.filesUsed >= row.maxFiles) return 'exhausted';
  return 'live';
}

function rowToLink(r: Record<string, unknown>): UploadLink {
  const base = {
    id: toStr(r['id']),
    kbSlug: toStr(r['kb_slug']),
    label: toStr(r['label']),
    createdBy: r['created_by'] ? toStr(r['created_by']) : null,
    expiresAt: toStr(r['expires_at']),
    revokedAt: r['revoked_at'] ? toStr(r['revoked_at']) : null,
    maxFiles: toNum(r['max_files']),
    maxBytes: toNum(r['max_bytes']),
    filesUsed: toNum(r['files_used']),
    bytesUsed: toNum(r['bytes_used']),
    createdAt: toStr(r['created_at']),
    lastUsedAt: r['last_used_at'] ? toStr(r['last_used_at']) : null,
  };
  return { ...base, status: statusOf(base) };
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A fixture row in the shape `rowToLink` produces from a database row.
 *
 * The two sides share `statusOf` rather than each deciding what "live" means:
 * status is derived from the same three columns on both paths, so an offline
 * link and a real one can never disagree about whether they are usable.
 */
function mockRowToLink(row: MockUploadLink): UploadLink {
  const base = {
    id: row.id,
    kbSlug: row.kbSlug,
    label: row.label,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    maxFiles: row.maxFiles,
    maxBytes: row.maxBytes,
    filesUsed: row.filesUsed,
    bytesUsed: row.bytesUsed,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
  return { ...base, status: statusOf(base) };
}

/**
 * Create a link and return the token exactly once.
 *
 * The token is not stored, only its hash, so this return value is the single
 * opportunity to capture it — the same contract as an API key.
 */
export async function createUploadLink(input: {
  kbSlug: string;
  label: string;
  createdBy?: string | null;
  expiresInHours?: number;
  maxFiles?: number;
  maxBytes?: number;
}): Promise<{ link: UploadLink; token: string }> {
  const token = randomBytes(32).toString('base64url');
  const expiresInHours = Math.min(Math.max(input.expiresInHours ?? 72, 1), 24 * 30);
  const maxFiles = Math.min(Math.max(input.maxFiles ?? 25, 1), 500);
  const maxBytes = Math.min(Math.max(input.maxBytes ?? 25 * 1024 * 1024, 1024), ABSOLUTE_MAX_BYTES);

  // Offline the row lands in the fixture, and the token contract is identical:
  // the token above is a real 256-bit secret, only its hash is stored, and
  // this return value is still the single opportunity to capture it. The
  // branch is in this function rather than in routes/kb-admin.ts because this
  // is what owns the INSERT — a guard in the handler would have hidden the
  // pair from the write-route scan without giving the write anywhere to go.
  if (config.mock.aurora) {
    const created = insertLink({
      id: randomUUID(),
      tokenHash: hashToken(token),
      kbSlug: input.kbSlug,
      label: input.label,
      createdBy: input.createdBy ?? null,
      // `NOW() + (:hours || ' hours')::interval`, from the clock.
      expiresAt: new Date(Date.parse(clock.nowIso()) + expiresInHours * 3_600_000).toISOString(),
      revokedAt: null,
      maxFiles,
      maxBytes,
      filesUsed: 0,
      bytesUsed: 0,
      createdAt: clock.nowIso(),
      lastUsedAt: null,
    });
    return { link: mockRowToLink(created), token };
  }

  const rows = await exec(
    `INSERT INTO kb_upload_links (token_hash, kb_slug, label, created_by, expires_at, max_files, max_bytes)
     VALUES (:hash, :slug, :label, :by, NOW() + (:hours || ' hours')::interval, :files, :bytes)
     RETURNING *`,
    [
      s('hash', hashToken(token)),
      s('slug', input.kbSlug),
      s('label', input.label),
      input.createdBy ? s('by', input.createdBy) : { name: 'by', value: { isNull: true } },
      s('hours', String(expiresInHours)),
      n('files', maxFiles),
      n('bytes', maxBytes),
    ],
  );
  const row = rows[0];
  if (!row) throw new Error('link insert returned no row');
  return { link: rowToLink(row), token };
}

export async function listUploadLinks(kbSlug?: string): Promise<UploadLink[]> {
  // This used to return `[]` — honest at the time, because nothing offline
  // could mint a link, so "no links" was the whole truth. It stopped being
  // true the moment `createUploadLink` gained a fixture to write into: a
  // create that returned 201 and a list that still said none would be a write
  // that reports success and cannot be seen. Reads the same rows the writes
  // move (mock/upload-links.ts), which also gives the panel its three
  // statuses to render.
  if (config.mock.aurora) return linksForKb(kbSlug).map(mockRowToLink);
  const rows = kbSlug
    ? await exec(
        `SELECT * FROM kb_upload_links WHERE kb_slug = :slug ORDER BY created_at DESC LIMIT 100`,
        [s('slug', kbSlug)],
      )
    : await exec(`SELECT * FROM kb_upload_links ORDER BY created_at DESC LIMIT 100`);
  return rows.map(rowToLink);
}

export async function revokeUploadLink(id: string): Promise<boolean> {
  // `revokeLink` reproduces the statement's `AND revoked_at IS NULL`, so
  // revoking twice returns false offline exactly as it does online and the
  // route's 404 keeps meaning what it says.
  if (config.mock.aurora) return revokeLink(id);
  const rows = await exec(
    `UPDATE kb_upload_links SET revoked_at = NOW()
      WHERE id = :id::uuid AND revoked_at IS NULL
      RETURNING id`,
    [s('id', id)],
  );
  return rows.length > 0;
}

/** Files that arrived through one link, newest first. */
export async function listLinkFiles(id: string): Promise<Array<{
  filename: string; s3Key: string; bytes: number; contentType: string | null; uploadedAt: string;
}>> {
  if (config.mock.aurora) {
    return filesForLink(id).map((f) => ({
      filename: f.filename,
      s3Key: f.s3Key,
      bytes: f.bytes,
      contentType: f.contentType,
      uploadedAt: f.uploadedAt,
    }));
  }
  const rows = await exec(
    `SELECT filename, s3_key, bytes, content_type, uploaded_at
       FROM kb_upload_link_files WHERE link_id = :id::uuid
      ORDER BY uploaded_at DESC LIMIT 200`,
    [s('id', id)],
  );
  return rows.map((r) => ({
    filename: toStr(r['filename']),
    s3Key: toStr(r['s3_key']),
    bytes: toNum(r['bytes']),
    contentType: r['content_type'] ? toStr(r['content_type']) : null,
    uploadedAt: toStr(r['uploaded_at']),
  }));
}

/**
 * Resolve a token to its link.
 *
 * The lookup is by hash, so the database never stores or sees a usable token.
 */
async function linkForToken(token: string): Promise<UploadLink | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const hash = hashToken(token);
  if (config.mock.aurora) {
    // By hash, never by token — see the note below, which applies unchanged.
    const row = findLinkByTokenHash(hash);
    return row ? mockRowToLink(row) : null;
  }
  const rows = await exec(
    `SELECT * FROM kb_upload_links WHERE token_hash = :hash LIMIT 1`,
    [s('hash', hash)],
  );
  const row = rows[0];
  if (!row) return null;

  // No constant-time comparison here, deliberately. The lookup is *by* hash,
  // so any row returned already matches; comparing it again always passes and
  // proves nothing. What matters is that the column holds a SHA-256 of the
  // token rather than the token, so timing differences in the index probe leak
  // at most which hash prefix exists — not a usable secret.
  return rowToLink(row);
}

/** What a recipient is allowed to know: enough to use the page, nothing more. */
export interface PublicLinkView {
  label: string;
  /** Human-facing destination name, never the bucket or prefix. */
  destination: string;
  status: UploadLink['status'];
  expiresAt: string;
  filesRemaining: number;
  maxBytes: number;
  allowedExtensions: string[];
}

export async function describeLinkForRecipient(token: string): Promise<PublicLinkView | null> {
  const link = await linkForToken(token);
  if (!link) return null;
  return {
    label: link.label,
    // Deliberately the registry name, not the S3 location. Someone holding a
    // drop link has no reason to learn the bucket layout.
    destination: link.kbSlug,
    status: link.status,
    expiresAt: link.expiresAt,
    filesRemaining: Math.max(0, link.maxFiles - link.filesUsed),
    maxBytes: link.maxBytes,
    allowedExtensions: [...ALLOWED_EXTENSIONS].sort(),
  };
}

export type UploadRefusal =
  | 'unknown-link' | 'revoked' | 'expired' | 'exhausted'
  | 'too-large' | 'bad-type' | 'empty';

/**
 * Accept one file through a link.
 *
 * Every check happens here rather than in a presigned-URL policy, because the
 * ones that matter — is this link still live, has it used its quota — are
 * facts about our data that S3 has no way to know.
 */
export async function uploadViaLink(
  token: string,
  filename: string,
  body: Buffer,
  contentType: string,
): Promise<
  | { ok: true; key: string; bytes: number }
  | { ok: false; refusal: UploadRefusal; detail: string }
> {
  const link = await linkForToken(token);
  if (!link) return { ok: false, refusal: 'unknown-link', detail: 'This upload link is not valid.' };

  if (link.status === 'revoked') {
    return { ok: false, refusal: 'revoked', detail: 'This link has been revoked.' };
  }
  if (link.status === 'expired') {
    return { ok: false, refusal: 'expired', detail: 'This link has expired.' };
  }
  if (link.status === 'exhausted') {
    return { ok: false, refusal: 'exhausted', detail: 'This link has already uploaded its maximum number of files.' };
  }
  if (body.length === 0) {
    return { ok: false, refusal: 'empty', detail: 'That file is empty.' };
  }
  if (body.length > link.maxBytes) {
    return {
      ok: false, refusal: 'too-large',
      detail: `That file is ${Math.round(body.length / 1024 / 1024)} MB; this link allows ${Math.round(link.maxBytes / 1024 / 1024)} MB per file.`,
    };
  }

  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return {
      ok: false, refusal: 'bad-type',
      detail: `${ext || 'That file type'} cannot be indexed. Allowed: ${[...ALLOWED_EXTENSIONS].sort().join(', ')}`,
    };
  }

  // Claim the slot before uploading, in one statement the database arbitrates.
  //
  // Checking `filesUsed >= maxFiles` above and incrementing afterwards is a
  // race: two uploads arriving together both read the same count, both pass,
  // and the link exceeds its quota. Since a leaked link's blast radius is
  // exactly this number, the check has to be the write. The same statement
  // re-tests revocation and expiry, which close the same way.
  // Offline the claim is `claimUploadSlot`, which re-tests revocation, expiry
  // and the file ceiling in one call for the same reason the statement does:
  // the check IS the write, and a mock that incremented without re-testing
  // would make a quota look enforced when it is not.
  const claimed = config.mock.aurora
    ? (claimUploadSlot(link.id, body.length) ? [{ id: link.id }] : [])
    : await exec(
    `UPDATE kb_upload_links
        SET files_used = files_used + 1,
            bytes_used = bytes_used + :bytes,
            last_used_at = NOW()
      WHERE id = :id::uuid
        AND revoked_at IS NULL
        AND expires_at > NOW()
        AND files_used < max_files
      RETURNING id`,
    [n('bytes', body.length), s('id', link.id)],
  );
  if (claimed.length === 0) {
    return {
      ok: false, refusal: 'exhausted',
      detail: 'This link just reached its limit, or was revoked while the file was uploading.',
    };
  }

  let result: Awaited<ReturnType<typeof uploadToLandingZone>>;
  try {
    result = await uploadToLandingZone(link.kbSlug, filename, body, contentType);
  } catch (err) {
    // Give the slot back — a failed upload should not consume quota.
    if (config.mock.aurora) {
      releaseUploadSlot(link.id, body.length);
    } else {
      await exec(
        `UPDATE kb_upload_links
            SET files_used = GREATEST(0, files_used - 1),
                bytes_used = GREATEST(0, bytes_used - :bytes)
          WHERE id = :id::uuid`,
        [n('bytes', body.length), s('id', link.id)],
      ).catch(() => { /* the counter is now slightly high; the file did not land */ });
    }
    throw err;
  }

  if (config.mock.aurora) {
    recordLinkFile({
      linkId: link.id,
      s3Key: result.key,
      filename: filename.slice(0, 512),
      bytes: body.length,
      contentType,
      uploadedAt: clock.nowIso(),
    });
  } else {
    await exec(
      `INSERT INTO kb_upload_link_files (link_id, s3_key, filename, bytes, content_type)
       VALUES (:id::uuid, :key, :name, :bytes, :ct)`,
      [
        s('id', link.id), s('key', result.key),
        s('name', filename.slice(0, 512)), n('bytes', body.length), s('ct', contentType),
      ],
    );
  }

  return { ok: true, key: result.key, bytes: body.length };
}

export { ALLOWED_EXTENSIONS };
