// The documents bucket, offline — one row per S3 object.
//
// WHY THIS EXISTS. `providers/landing-zones.ts` is the S3 half of the
// knowledge surface: the authenticated upload on `/admin/knowledge`, the drop
// link a recipient uses, the `.keep` marker provisioning places, and the file
// browser that lists what landed. Offline every one of those threw or lied,
// and the two failure shapes were both bad in the way docs/mock-floor.md warns
// about:
//
//   * `uploadToLandingZone` threw `DOCUMENTS_BUCKET not configured` — so the
//     drop page and the landing-zone uploader 500'd, and `uploadViaLink` had
//     already claimed the link's quota slot before finding out.
//   * `listLandingZoneFiles` and `getLandingZoneStats` returned an EMPTY page
//     for the same missing bucket, with a 200. An unconfigured bucket and an
//     empty prefix are not the same state, and rendering them identically is
//     precisely "an unbuilt feature and an unseeded one look the same".
//
// The fixture is the bucket. Objects are keyed the way S3 keys them — full
// key, not path segments — because every caller here slices `prefix.length`
// off the key and one of them filters `.keep` that way.
//
// No `objectCount` or `totalBytes` lives on this module (contract.ts rule 1):
// `getLandingZoneStats` derives both from the rows, which is the bug that
// section of the contract is named after.

import { clock, defineFixture, sumBy } from './core/index.js';

/** The bucket name the offline world reports. Distinguishable on sight. */
export const MOCK_DOCUMENTS_BUCKET = 'orgiq-documents-mock';

export interface LandingZoneObject {
  /** Full S3 key, including the KB's prefix. */
  key: string;
  size: number;
  lastModified: string;
  contentType: string;
}

/**
 * The key `uploadToLandingZone` would file this object under.
 *
 * The date segment is part of the key the provider composes
 * (`<prefix><YYYY-MM-DD>/<file>`), so it has to move with the object's age
 * rather than be typed in: a hard-coded `2026-07-28` beside a `daysAgo(9)`
 * timestamp is a row that contradicts itself the day after it is written, and
 * it is the same class of bug as an import-time stamp (contract.ts rule 3).
 */
export function landingKey(prefix: string, daysAgo: number, filename: string): string {
  return `${prefix}${clock.daysAgo(daysAgo).slice(0, 10)}/${filename}`;
}

/** The seeded onboarding upload — named so mock/upload-links.ts can point its
 *  `kb_upload_link_files` row at the same object rather than retype the key. */
export const SEEDED_ONBOARDING_UPLOAD = {
  daysAgo: 9,
  filename: 'new-hire-runbook.md',
  bytes: 14_812,
  contentType: 'text/markdown',
} as const;

export function seededOnboardingUploadKey(): string {
  return landingKey(
    'orgiq-onboarding/',
    SEEDED_ONBOARDING_UPLOAD.daysAgo,
    SEEDED_ONBOARDING_UPLOAD.filename,
  );
}

/**
 * `default` — a handful of objects under `orgiq-onboarding/`, the one fixture
 *             KB whose s3Prefix actually describes where its objects live (see
 *             mock/kb-registry.ts's header on why `orgiq-default`'s does not).
 *             So the file browser has something to show for exactly one KB and
 *             an honest empty state for the others — which is what the real
 *             bucket looks like today.
 * `empty`    — the bucket exists and holds nothing. Distinct from "no bucket",
 *              which is now the only thing an unconfigured deployment reports.
 */
export const landingZoneObjects = defineFixture<LandingZoneObject>({
  key: 'landing-zone-objects',
  scenarios: {
    default: () => [
      {
        key: 'orgiq-onboarding/.keep',
        size: 0,
        lastModified: clock.daysAgo(42),
        contentType: 'application/octet-stream',
      },
      {
        key: seededOnboardingUploadKey(),
        size: SEEDED_ONBOARDING_UPLOAD.bytes,
        lastModified: clock.daysAgo(SEEDED_ONBOARDING_UPLOAD.daysAgo),
        contentType: SEEDED_ONBOARDING_UPLOAD.contentType,
      },
      {
        key: landingKey('orgiq-onboarding/', 4, 'platform-team-primer.pdf'),
        size: 402_113,
        lastModified: clock.daysAgo(4),
        contentType: 'application/pdf',
      },
      {
        key: landingKey('orgiq-onboarding/', 1, 'oncall-expectations.txt'),
        size: 3_204,
        lastModified: clock.hoursAgo(30),
        contentType: 'text/plain',
      },
    ],
    empty: () => [],
  },
});

/** Objects under a prefix, newest first — the order S3 does NOT guarantee and
 *  every caller here sorts for itself, so the fixture supplies it once. */
export function objectsUnder(prefix: string): LandingZoneObject[] {
  return landingZoneObjects
    .rows()
    .filter((o) => o.key.startsWith(prefix))
    .sort((a, b) => b.lastModified.localeCompare(a.lastModified));
}

/** Total bytes under a prefix — a selector, never a stored field. */
export function bytesUnder(prefix: string): number {
  return sumBy(objectsUnder(prefix), 'size');
}

/**
 * Write one object, replacing any object already at that key.
 *
 * PutObject overwrites; a fixture that appended would let one key hold two
 * rows and make `objectCount` disagree with what a second upload of the same
 * filename actually leaves behind.
 */
export function putObject(o: LandingZoneObject): LandingZoneObject {
  const rows = landingZoneObjects.rows();
  const i = rows.findIndex((r) => r.key === o.key);
  if (i >= 0) rows.splice(i, 1, o);
  else rows.push(o);
  return o;
}

/** Delete one object. Returns whether there was one — DeleteObject does not. */
export function deleteObject(key: string): boolean {
  const rows = landingZoneObjects.rows();
  const i = rows.findIndex((r) => r.key === key);
  if (i < 0) return false;
  rows.splice(i, 1);
  return true;
}
