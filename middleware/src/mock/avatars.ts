// Avatars for the mock cast — the `avatar_url` column (schema/orgiq_schema.sql
// `people`, schema/identity_schema.sql `app_users`) as the offline world fills it.
//
// The selectable demo cast uses commissioned photographic synthetic
// portraits under /avatars/photos/. All 71 seeded identities are covered;
// unknown people and the empty fixture still use initials.
// generate-local.mjs preserves photo selection and checks the manifest/files.
// Linked users show their PERSON's face (personId ?? userId).
//
// Registered, so a surface's no-avatar state is a scenario rather than an edit:
//   POST /api/__mock/scenario {"scenario":"empty","fixture":"avatars"}
// and every composite falls back to initials. Ids outside the rows (the
// `large` graph clones, an account created through /admin/identity/users)
// read as null for the same reason a real row with a NULL column does.

import { defineFixture } from './core/index.js';
import { seededPeople } from './people.js';
import { PORTRAIT_URLS } from './portrait-urls.js';

export interface MockAvatar {
  /** A `people.id` (p-NNN) or an unlinked `app_users.id` (u-*). */
  subjectId: string;
  url: string | null;
}

/**
 * The app users with no linked person — providers/identity.ts FALLBACK_USERS
 * rows whose `personId` is null. `__tests__/avatars.test.ts` holds this list to
 * that fixture and to the files on disk, so neither can drift from it.
 */
export const UNLINKED_USER_IDS = [
  'u-operator', 'u-hr',
  'u-asha', 'u-jonas', 'u-farah',
  'u-mira', 'u-lena', 'u-sana',
  'u-ines', 'u-kofi', 'u-dara', 'u-tomas',
] as const;

// One generated index owns portrait selection for the fixture and portal.
/** The served portrait path; generate-local.mjs preserves this selection. */
export function localAvatarPath(subjectId: string): string | null {
  return PORTRAIT_URLS[subjectId] ?? null;
}

export const avatars = defineFixture<MockAvatar>({
  key: 'avatars',
  scenarios: {
    default: () => [...seededPeople.map((p) => p.id), ...UNLINKED_USER_IDS]
      .map((subjectId) => ({ subjectId, url: localAvatarPath(subjectId) })),
    empty: () => [],
  },
});

/** The avatar URL for a person or unlinked user id, or null (initials). */
export function mockAvatarUrl(subjectId: string | null | undefined): string | null {
  if (!subjectId) return null;
  return avatars.rows().find((row) => row.subjectId === subjectId)?.url ?? null;
}
