// The asset library, offline — the catalog `dev:mock` serves, and the
// registered as a fixture so the scenarios can reach it.
//
// WHY THIS FILE EXISTS. `MOCK_ASSETS` was a `LibraryAsset[]` at module scope
// inside providers/prompt-library.ts. It registered no fixture, so
// `GET /api/__mock/state` could not see it and `fixtureRegistry.resetAll()`
// could not move it: `/api/library` and `/api/library/:id` answered the same
// 8,328 bytes in `default`, `empty`, `error`, `large` and `fresh` alike.
// `/iq/library` was therefore the one flagship read on this ladder with no
// auditable empty state and no reachable degraded state — you could not see
// what the page does with nothing, or with a catalog that failed to load,
// without editing the source. Three floor problems, all structural:
//
//   1. NO SCENARIO CONTROL (contract.ts #4). Above.
//   2. IMPORT-TIME TIMESTAMPS (#3). `ago(h)` was
//      `new Date(Date.now() - h * 3_600_000)` evaluated inside an array
//      literal, so `updated 2h ago` meant two hours before the PROCESS
//      BOOTED. A dev server up for a day showed an asset "updated 2h ago"
//      that the corpus had aged 26 hours past.
//
// AGE IS THE CLAIM, NOT THE DAY, so nothing below uses `keepWithinToday`:
// both the table column and the drawer render `updatedAt` through
// `relativeTime`, and no surface buckets an asset by calendar day. Same
// reasoning mock/promotions.ts records for its observation stamps.
//
// IDS AND WIRE STRINGS ARE NOT INVENTED. `kind` is PromptKind and `tier` is
// PromptTier (lib/prompt-contract.ts); `lifecycleStatus` values are the ones
// `observability.prompt_version_meta.lifecycle_status` carries.

import { clock, defineFixture } from './core/index.js';
import { promptEvalRuns } from './prompt-evals.js';
// Type-only, so it is erased at compile: providers/prompt-library.ts imports
// the fixture below at run time, and a value import back the other way would
// be a genuine cycle rather than a shared shape. Same pattern as
// mock/promotions.ts.
import type {
  LibraryAsset, LibraryAssetRow,
} from '../providers/prompt-library.js';
import type { PromptContract, PromptKind, PromptTier } from '../lib/prompt-contract.js';
import { EMPTY_CONTRACT } from '../lib/prompt-contract.js';

/** `h` hours before NOW — sampled inside the rows factory, so a reset re-ages. */
const hoursAgo = (h: number): string => clock.hoursAgo(h);

function asset(
  a: Partial<LibraryAssetRow> & Pick<LibraryAssetRow, 'id' | 'name' | 'description' | 'kind'>,
): LibraryAssetRow {
  return {
    tier: 'sandbox', roles: [], tags: [], ownerName: null, version: '1',
    lifecycleStatus: 'published', contract: EMPTY_CONTRACT, evalPassRate: null,
    usedBy: [], updatedAt: hoursAgo(48), template: '', signoffs: 0, designReviewId: null, ...a,
  };
}

function contract(
  kind: PromptKind, tier: PromptTier,
  variables: PromptContract['variables'],
  guardrailId: string | null = null,
): PromptContract {
  return { kind, tier, variables, guardrailId };
}

/**
 * The offline catalog. Deliberately spans every kind, so the facets are
 * exercised offline and the "all kinds of use case for all the different
 * system roles" claim is visible rather than asserted.
 */
function seedAssets(): LibraryAssetRow[] {
  return [
    // ── system: the agent prompts Bedrock Prompt Management holds ──
    asset({
      id: 'orgiq-supervisor-system-prompt', name: 'Supervisor · system prompt',
      description: 'Routes an org question to the right sub-agent and composes the answer.',
      kind: 'system', tier: 'internal', roles: ['member', 'sme', 'org-leader'],
      tags: ['agent', 'routing'], ownerName: 'Rachel Kowalski', version: '7',
      lifecycleStatus: 'promoted', evalPassRate: 0.94, usedBy: ['orgiq-supervisor'],
      updatedAt: hoursAgo(30),
    }),
    asset({
      id: 'orgiq-search-system-prompt', name: 'Search · system prompt',
      description: 'Finds people, skills and decisions in the org graph and cites them.',
      kind: 'system', tier: 'internal', roles: ['member', 'sme'], tags: ['agent', 'graph'],
      ownerName: 'Rachel Kowalski', version: '4', lifecycleStatus: 'promoted',
      evalPassRate: 0.91, usedBy: ['orgiq-search'], updatedAt: hoursAgo(72),
    }),

    // ── prompt: a person runs it with inputs ──
    asset({
      id: 'lib-stakeholder-email', name: 'Stakeholder update email',
      description: 'Draft an initiative status email from the board state and a tone.',
      kind: 'prompt', tier: 'internal', roles: ['program-owner', 'org-leader', 'sme'],
      tags: ['writing', 'comms'], ownerName: 'Mia Singh', version: '3',
      lifecycleStatus: 'published', evalPassRate: 0.88, usedBy: ['portal:studio'],
      updatedAt: hoursAgo(6), signoffs: 1,
      template: 'Write a status email about {{initiative}} for {{audience}}, in a {{tone}} register.\n\nBoard state:\n{{board_state}}',
      contract: contract('prompt', 'internal', [
        { name: 'initiative', type: 'text', required: true, source: 'caller',
          description: 'Initiative the update is about' },
        { name: 'audience', type: 'enum', required: true, source: 'caller',
          options: ['execs', 'the team', 'a customer'] },
        { name: 'tone', type: 'text', required: false, source: 'literal', default: 'plain and direct' },
        { name: 'board_state', type: 'longtext', required: true, source: 'retrieved',
          description: 'Sprint/board rollup pulled at render time — fenced, never inlined' },
      ]),
    }),
    asset({
      id: 'lib-adr-summary', name: 'Design decision summary',
      description: 'Turn a design thread into an ADR-shaped decision record.',
      kind: 'prompt', tier: 'internal', roles: ['sme', 'program-owner'],
      tags: ['design', 'writing'], ownerName: 'Nora DaSilva', version: '2',
      lifecycleStatus: 'published', evalPassRate: 0.9, usedBy: ['portal:designs'],
      updatedAt: hoursAgo(20),
      contract: contract('prompt', 'internal', [
        { name: 'thread', type: 'longtext', required: true, source: 'retrieved' },
      ]),
    }),

    // ── evaluator: a pipeline runs it, no human, abbreviated governance ──
    asset({
      id: 'lib-csrf-check', name: 'CSRF risk evaluator',
      description: 'Given a request change, judge whether it weakens CSRF protection. Returns a verdict + evidence.',
      kind: 'evaluator', tier: 'endpoint', roles: ['sme', 'hr-admin'],
      tags: ['security', 'review', 'classifier'], ownerName: 'Simone Chang', version: '5',
      lifecycleStatus: 'deployed', evalPassRate: 0.96,
      usedBy: ['bot:inference-canary-nightly', 'endpoint:/v1/checks/csrf'], updatedAt: hoursAgo(3),
      signoffs: 2, designReviewId: 'des-auth-rotation',
      template: 'Assess the {{framework}} change below for CSRF weakening.\n\n{{diff}}',
      contract: contract('evaluator', 'endpoint', [
        { name: 'diff', type: 'longtext', required: true, source: 'untrusted',
          description: 'The PR diff — attacker-controllable, always fenced' },
        { name: 'framework', type: 'enum', required: false, source: 'caller',
          options: ['express', 'django', 'rails', 'spring'], default: 'express' },
      ], 'gr-security-1'),
    }),
    asset({
      id: 'lib-pii-scan', name: 'PII leak evaluator',
      description: 'Flag personal data in a document before it reaches the knowledge base.',
      kind: 'evaluator', tier: 'internal', roles: ['hr-admin'], tags: ['security', 'privacy'],
      ownerName: 'Helen Desai', version: '2', lifecycleStatus: 'published', evalPassRate: 0.93,
      usedBy: ['pipeline:ingestion'], updatedAt: hoursAgo(50), signoffs: 1,
      template: 'Flag personal data in the document below.\n\n{{document}}',
      contract: contract('evaluator', 'internal', [
        { name: 'document', type: 'longtext', required: true, source: 'untrusted' },
      ]),
    }),
  ];
}

/**
 * The catalog.
 *
 * `default` — the six-asset demo corpus above.
 * `empty`   — nothing published. Declared explicitly: an undeclared scenario
 *             falls back to `default`, and "the library is empty" is the one
 *             state a six-asset seed can never show. It is also the world
 *             that proves the facets render from an empty catalog rather
 *             than throwing.
 * `error`   — the catalog is unreadable. Throwing here is the POINT: live,
 *             `loadAllAssets` merges Bedrock Prompt Management with Aurora's
 *             `prompt_version_meta`, and this is how an auditor reaches the
 *             page's failed-load state over HTTP
 *             (`POST /api/__mock/scenario {"scenario":"error","fixture":"library-assets"}`)
 *             instead of revoking an IAM grant. Note the live path degrades
 *             each source independently and only both-down produces an empty
 *             catalog — so the mock's throw is louder than any single live
 *             failure, which is the honest direction to err in a fixture.
 */
export const libraryAssets = defineFixture<LibraryAssetRow>({
  key: 'library-assets',
  scenarios: {
    default: seedAssets,
    empty: () => [],
    error: () => {
      throw new Error('library catalog unavailable: Bedrock ListPrompts and prompt_version_meta both failed');
    },
  },
});

/** The newest eval run for an asset version, or null when it has never been
 *  run. The runs are the rows; the rate on the asset is read from them. */
function latestRunRate(assetId: string, version: string): number | null | undefined {
  let latest: { ranAt: string; passRate: number | null } | undefined;
  for (const run of promptEvalRuns.rows()) {
    if (run.assetId !== assetId || run.version !== version) continue;
    if (!latest || run.ranAt > latest.ranAt) latest = run;
  }
  return latest ? latest.passRate : undefined;
}

export function mockLibraryAssets(): LibraryAsset[] {
  return libraryAssets.rows().map((row) => {
    // Health & usage, Release readiness and the Evals panel used to disagree
    // on one asset's pass rate — the asset carried a seeded literal while the
    // panel read the latest run. The run corpus is the source; the seeded
    // figure stands only for an asset that has never been run.
    const fromRuns = latestRunRate(row.id, row.version);
    const evalPassRate = fromRuns === undefined ? row.evalPassRate : fromRuns;
    return { ...row, evalPassRate };
  });
}
