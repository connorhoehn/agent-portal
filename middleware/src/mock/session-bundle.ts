// The seeded session bundle: what a devbox session runs with, offline.
//
// Stamps are clock-relative so a frozen clock pins the bundle's age. The
// one-version gap between the bundle's `skill-flaky-test-triage` (v2) and the
// library's (v3) is what makes the drift column show a stale skill.

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
//
// The session brief replaced bundles as the one thing a box receives (decision
// 4, 2026-10-14; middleware lib/run-brief.ts): the hook is `lab brief`, which
// prints the run's frozen brief, and the skills below reach the run as that
// brief's "Skills on this box" section. `lab recall` is a manual command now.
const LAB_BRIEF_HOOK: SessionHook = {
  event: 'SessionStart',
  command: 'lab brief',
  description: 'Print this run\'s frozen session brief (task, project, binding decisions, skills on the box, selected runbooks) — baked via /etc/claude-code/managed-settings.json.',
  enabled: true,
};

const DEVBOX_SETTINGS: Record<string, string | boolean | number> = {
  CLAUDE_CODE_USE_BEDROCK: true,
  DISABLE_AUTOUPDATER: true,
  ANTHROPIC_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  ANTHROPIC_SMALL_FAST_MODEL: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
};

function seedBundles(): RawBundle[] {
  return [
    {
      id: 'sb-2026-08-fleet', version: 'v12',
      publishedAt: ago(9 * 24), publishedBy: 'Eli Garcia',
      hooks: [{ ...LAB_BRIEF_HOOK }],
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
  ];
}

/**
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
