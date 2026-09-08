// Session bundles — what a devbox session is actually running, offline.
//
// These two bundles were a `MOCK_BUNDLES: RawBundle[]` inside
// providers/session-bundle.ts. They moved here because publishing is the one
// write in this product that rewrites rows it did not target:
// `publishBundle` supersedes whichever bundle is currently `live`, promotes
// the named one, and re-stamps its `publishedAt` and `publishedBy`. Against a
// bare array that is a one-way door — the fleet's live bundle is `v13` for the
// rest of the process's life, with no way back short of a restart — which is
// why the wire capture's write policy refused
// `POST /api/session-bundle/:id/publish` outright rather than replaying it.
// Behind a fixture, `POST /api/__mock/reset` puts `v12` back on the fleet.
//
// The stamps were also minted off the wall clock (`new Date(Date.now() - h *
// 3_600_000)`), so a frozen-clock test could not assert how old the live
// bundle was.
//
// AGE IS THE CLAIM, NOT THE DAY, so neither row uses `keepWithinToday`: the
// Release surface renders "published 9 days ago", and nothing buckets a
// bundle by calendar day. A bundle published 20 hours ago is meant to read as
// yesterday-ish whatever the wall clock says.
//
// IDS AND VERSIONS ARE PART OF THE CONTRACT. `sb-2026-08-fleet` (v12, live)
// and `sb-2026-09-refresh` (v13, pending) are addressed by name from
// providers/__tests__/session-bundle.test.ts, and the deliberate one-version
// gap between the live bundle's `skill-flaky-test-triage` (v2) and the
// library's (v3) is the only thing that makes the drift panel show anything.

import { clock, defineFixture } from './core/index.js';
// Type-only, so it is erased at compile: providers/session-bundle.ts imports
// the fixture below at run time, and a value import back the other way would
// be a genuine cycle rather than a shared shape.
import type { RawBundle, SessionHook } from '../providers/session-bundle.js';

/** `h` hours before now — sampled inside the rows factory, so a reset re-ages. */
const ago = (h: number): string => clock.hoursAgo(h);

/**
 * The library's current skill versions — mirrors prompt-library.ts's three
 * skill assets exactly, so drift here reflects the same catalog a person would
 * see on /iq/library.
 *
 * Not a fixture: these are the *library's* versions, not the bundle's rows.
 * A bundle's `status` per skill is derived against them on every read
 * (`skillStatus`), never stored — which is the rule that keeps a bundle from
 * claiming `current` about a skill the library moved past an hour ago.
 */
export const MOCK_LIBRARY_VERSIONS: Record<string, string> = {
  'skill-flaky-test-triage': '3',
  'skill-cold-start-aurora': '2',
  'skill-pr-review-scoped': '1',
};

// Mirrors agents/devbox/managed-settings.json + the Dockerfile's ENV block —
// this is what "live" means for the fleet today, not a hypothetical.
const LAB_RECALL_HOOK: SessionHook = {
  event: 'SessionStart',
  command: 'lab recall',
  description: 'Print the fleet\'s memory for this repo — the read half of the lab loop, baked via /etc/claude-code/managed-settings.json.',
  enabled: true,
};

const DEVBOX_SETTINGS: Record<string, string | boolean | number> = {
  CLAUDE_CODE_USE_BEDROCK: true,
  DISABLE_AUTOUPDATER: true,
  ANTHROPIC_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  ANTHROPIC_SMALL_FAST_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

/**
 * The bundle each row ships. Written out per bundle rather than shared by
 * reference: the v13 refresh differs from v12 in exactly one version number,
 * and a shared array would make that difference impossible to express.
 */
function seedBundles(): RawBundle[] {
  return [
    {
      id: 'sb-2026-08-fleet', version: 'v12',
      publishedAt: ago(9 * 24), publishedBy: 'Eli Garcia',
      hooks: [{ ...LAB_RECALL_HOOK }],
      skills: [
        // Bundled at v2, library has moved to v3 — one deliberate stale entry.
        { id: 'skill-flaky-test-triage', name: 'Triage a flaky test',
          description: 'Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.',
          version: '2', source: 'library' },
        { id: 'skill-cold-start-aurora', name: 'Recover a cold Aurora Data API',
          description: 'Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.',
          version: '2', source: 'library' },
        { id: 'skill-pr-review-scoped', name: 'Review a PR diff-scoped',
          description: 'Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.',
          version: '1', source: 'library' },
      ],
      settings: { ...DEVBOX_SETTINGS },
      appliesTo: ['fleet'],
      status: 'live',
    },
    {
      // Picks up the flaky-test skill's v3 and keeps everything else — the
      // publish this bundle awaits is what clears that one stale entry above.
      id: 'sb-2026-09-refresh', version: 'v13',
      publishedAt: ago(20), publishedBy: 'Layla Hassan',
      hooks: [{ ...LAB_RECALL_HOOK }],
      skills: [
        { id: 'skill-flaky-test-triage', name: 'Triage a flaky test',
          description: 'Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.',
          version: '3', source: 'library' },
        { id: 'skill-cold-start-aurora', name: 'Recover a cold Aurora Data API',
          description: 'Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.',
          version: '2', source: 'library' },
        { id: 'skill-pr-review-scoped', name: 'Review a PR diff-scoped',
          description: 'Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.',
          version: '1', source: 'library' },
      ],
      settings: { ...DEVBOX_SETTINGS },
      appliesTo: ['fleet'],
      status: 'pending',
    },
  ];
}

/**
 * The bundle ladder.
 *
 * `empty` — nothing has ever been published, so the fleet is running whatever
 *           the image baked and the Release surface has to say so. Declared
 *           explicitly: an undeclared scenario falls back to `default`, and
 *           `getLiveBundle()` returning null is a branch no seeded world
 *           reaches — the surface's "no bundle published yet" copy is written
 *           for exactly this.
 */
export const sessionBundles = defineFixture<RawBundle>({
  key: 'session-bundles',
  scenarios: {
    default: seedBundles,
    empty: () => [],
  },
});
