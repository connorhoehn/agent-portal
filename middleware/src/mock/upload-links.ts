// Token-scoped upload links, offline — `kb_upload_links` + `kb_upload_link_files`.
//
// WHY THIS EXISTS. `providers/upload-links.ts` had exactly one mock branch,
// on `listUploadLinks`, and it returned `[]`. So the whole surface read as
// "there are no links" while every write on it — mint a link, revoke one,
// resolve a token, accept a file through it — went straight to the RDS Data
// API and 500'd offline. `/admin/knowledge`'s ShareLinks panel could show its
// empty state and nothing else, and `POST /api/drop/:token/upload`, the one
// unauthenticated write in the app, could not be exercised at all.
//
// THE TOKEN CONTRACT IS UNCHANGED. The real table stores a SHA-256 of the
// token and never the token, so `linkForToken` hashes what it is given and
// looks the hash up. This fixture stores `tokenHash` for the same reason and
// resolves the same way: an offline link is minted with a real 256-bit token,
// returned exactly once, and thereafter only its hash exists here. Storing the
// token would make the fixture a weaker thing than the table it stands in for,
// and would quietly delete the property the whole feature rests on.
//
// The seeded links carry a `tokenHash` of a DECLARED token (below) so an
// auditor can drive the drop page offline without minting one first. That is
// the one thing this fixture knows that the table would not — and it is
// declared, in the open, rather than smuggled in as a plaintext column.
//
// No `filesUsed`-style totals are written beside the file rows: `filesUsed`
// and `bytesUsed` are columns the real UPDATE increments transactionally, so
// they are carried as columns here too and moved by the same claim.

import { createHash } from 'node:crypto';
import { clock, defineFixture, DAY_MS } from './core/index.js';
import { SEEDED_ONBOARDING_UPLOAD, seededOnboardingUploadKey } from './landing-zone.js';

/**
 * An instant `days` in the FUTURE, derived from the clock at read time.
 *
 * A live link's whole point is that it expires later than now, and `daysAgo`
 * clamps a negative age to zero on purpose — the clock will not hand out the
 * future. Deriving it here inside the row factory is what canary-weight.ts's
 * note prescribes for exactly this case: still a clock read, still frozen by
 * `freezeClock`, and never a literal baked at import (contract.ts rule 3).
 */
function daysFromNow(days: number): string {
  return new Date(Date.parse(clock.nowIso()) + days * DAY_MS).toISOString();
}

/** How a token becomes the column. Same digest the provider uses. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * The token the seeded live link answers to.
 *
 * Declared so `GET /api/drop/:token` and `POST /api/drop/:token/upload` are
 * reachable offline — the wire capture skips both today with "no value found
 * for :token", because a token is not something a listing can hand you. It is
 * long enough to pass `linkForToken`'s own 20..200 character bound.
 */
export const MOCK_LIVE_DROP_TOKEN = 'mock-drop-token-for-offline-audits-0001';

/** A row of `kb_upload_links`, in the provider's own casing. */
export interface MockUploadLink {
  id: string;
  tokenHash: string;
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
}

/** A row of `kb_upload_link_files`. */
export interface MockUploadLinkFile {
  linkId: string;
  s3Key: string;
  filename: string;
  bytes: number;
  contentType: string | null;
  uploadedAt: string;
}

const MB = 1024 * 1024;

/**
 * `default` — three links covering the three states the panel styles
 *             differently and the drop page refuses differently: one live
 *             (the one `MOCK_LIVE_DROP_TOKEN` opens), one revoked, one
 *             expired. `status` is NOT stored — `statusOf` in the provider
 *             derives it from `revokedAt`/`expiresAt`/`filesUsed`, and a
 *             stored copy is contract.ts rule 1 in its original form.
 * `empty`   — no link has ever been minted, which is what the panel's own
 *             "no links yet" state is written for.
 */
export const uploadLinks = defineFixture<MockUploadLink>({
  key: 'kb-upload-links',
  scenarios: {
    default: () => [
      {
        id: 'b0000001-0000-4000-8000-000000000001',
        tokenHash: hashToken(MOCK_LIVE_DROP_TOKEN),
        kbSlug: 'orgiq-onboarding',
        label: 'Platform team — onboarding docs',
        createdBy: 'u-operator',
        expiresAt: daysFromNow(5),
        revokedAt: null,
        maxFiles: 25,
        maxBytes: 25 * MB,
        filesUsed: 1,
        bytesUsed: SEEDED_ONBOARDING_UPLOAD.bytes,
        createdAt: clock.daysAgo(2),
        lastUsedAt: clock.daysAgo(SEEDED_ONBOARDING_UPLOAD.daysAgo),
      },
      {
        id: 'b0000002-0000-4000-8000-000000000002',
        tokenHash: hashToken('mock-drop-token-revoked-by-an-admin-0002'),
        kbSlug: 'orgiq-onboarding',
        label: 'Contractor drop — revoked after the engagement ended',
        createdBy: 'u-operator',
        expiresAt: daysFromNow(20),
        revokedAt: clock.daysAgo(1),
        maxFiles: 10,
        maxBytes: 10 * MB,
        filesUsed: 0,
        bytesUsed: 0,
        createdAt: clock.daysAgo(14),
        lastUsedAt: null,
      },
      {
        id: 'b0000003-0000-4000-8000-000000000003',
        tokenHash: hashToken('mock-drop-token-that-timed-out-0003'),
        kbSlug: 'orgiq-default',
        label: 'Legal review packet — 72h window',
        createdBy: 'u-operator',
        expiresAt: clock.daysAgo(4),
        revokedAt: null,
        maxFiles: 5,
        maxBytes: 5 * MB,
        filesUsed: 2,
        bytesUsed: 91_004,
        createdAt: clock.daysAgo(7),
        lastUsedAt: clock.daysAgo(5),
      },
    ],
    empty: () => [],
  },
});

/**
 * Files that arrived through a link.
 *
 * The one seeded row IS the object the landing-zone fixture holds — key,
 * bytes and content type all come from there rather than being retyped, so a
 * link's file list and the bucket it wrote into cannot disagree about what
 * landed. (`filesUsed: 1` / `bytesUsed: 14_812` on the link above is the
 * column the real UPDATE increments, not a count of these rows.)
 */
export const uploadLinkFiles = defineFixture<MockUploadLinkFile>({
  key: 'kb-upload-link-files',
  scenarios: {
    default: () => [
      {
        linkId: 'b0000001-0000-4000-8000-000000000001',
        s3Key: seededOnboardingUploadKey(),
        filename: SEEDED_ONBOARDING_UPLOAD.filename,
        bytes: SEEDED_ONBOARDING_UPLOAD.bytes,
        contentType: SEEDED_ONBOARDING_UPLOAD.contentType,
        uploadedAt: clock.daysAgo(SEEDED_ONBOARDING_UPLOAD.daysAgo),
      },
    ],
    empty: () => [],
  },
});

// ─── Selectors and writes ────────────────────────────────────────────────────

export function findLinkById(id: string): MockUploadLink | undefined {
  return uploadLinks.rows().find((l) => l.id === id);
}

export function findLinkByTokenHash(hash: string): MockUploadLink | undefined {
  return uploadLinks.rows().find((l) => l.tokenHash === hash);
}

/** Newest first, as the provider's `ORDER BY created_at DESC` returns them. */
export function linksForKb(kbSlug?: string): MockUploadLink[] {
  return uploadLinks
    .rows()
    .filter((l) => !kbSlug || l.kbSlug === kbSlug)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function filesForLink(linkId: string): MockUploadLinkFile[] {
  return uploadLinkFiles
    .rows()
    .filter((f) => f.linkId === linkId)
    .sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt));
}

/** Insert a link row. The caller holds the only copy of the token. */
export function insertLink(row: MockUploadLink): MockUploadLink {
  uploadLinks.rows().push(row);
  return row;
}

/**
 * Revoke, as `UPDATE … WHERE id = :id AND revoked_at IS NULL RETURNING id`:
 * revoking an already-revoked link moves nothing and returns false, which is
 * what makes the route's 404 correct rather than a lie.
 */
export function revokeLink(id: string): boolean {
  const link = findLinkById(id);
  if (!link || link.revokedAt) return false;
  link.revokedAt = clock.nowIso();
  return true;
}

/**
 * The quota claim, as one operation — the same reason the provider does it in
 * a single UPDATE. Returns false when the link is no longer eligible, which is
 * the race the real statement's WHERE clause arbitrates.
 */
export function claimUploadSlot(id: string, bytes: number): boolean {
  const link = findLinkById(id);
  if (!link) return false;
  if (link.revokedAt) return false;
  if (new Date(link.expiresAt).getTime() <= clock.now().getTime()) return false;
  if (link.filesUsed >= link.maxFiles) return false;
  link.filesUsed += 1;
  link.bytesUsed += bytes;
  link.lastUsedAt = clock.nowIso();
  return true;
}

/** Give a claimed slot back after a failed upload. */
export function releaseUploadSlot(id: string, bytes: number): void {
  const link = findLinkById(id);
  if (!link) return;
  link.filesUsed = Math.max(0, link.filesUsed - 1);
  link.bytesUsed = Math.max(0, link.bytesUsed - bytes);
}

export function recordLinkFile(row: MockUploadLinkFile): MockUploadLinkFile {
  uploadLinkFiles.rows().push(row);
  return row;
}
