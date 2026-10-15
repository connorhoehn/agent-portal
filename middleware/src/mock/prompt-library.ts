// The asset library, offline — the catalog `dev:mock` serves, and the
// provenance that makes it the far end of the distillation ladder.
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
//      BOOTED. A dev server up for a day showed a skill "updated 2h ago"
//      that the corpus had aged 26 hours past.
//   3. A TYPED AGGREGATE OVER ROWS IT DID NOT OWN (#1), and it had already
//      drifted into fiction. Every `derivedFrom` block stored a
//      `supportCount`/`sessionCount` pair beside three `top` citations, and
//      the drawer renders that pair as a banner —
//      "11 observations across 6 sessions" over three cards. The cited ids
//      (`exp-441`, `exp-388`, `exp-352`, `exp-501`, `exp-498`, `exp-577`,
//      `exp-570`, `exp-233`) existed NOWHERE: the shared-memory store spells
//      its observations `obs-NNN` (mock/distillation.ts), the promotions
//      inbox spells its own `obs-<topic>-N` (mock/promotions.ts), and
//      `lab_experiences` offline holds `exp-mock-N` (mock/lab.ts). So the
//      Library claimed a published skill stood on eleven observations across
//      six sessions and named three of them, and not one of those three was
//      a record any surface in this middleware could open. That is precisely
//      the lineage break docs/mock-floor.md exists to stop — a promoted item
//      with no source finding — and no test could see it, because the count
//      and the citations were stored side by side and agreed with each other.
//
// SO PROVENANCE IS DERIVED, NOT STORED. `derivationFor` below walks the real
// lineage the distillation store already holds —
// library item → library-links row → L2 artifact → its L1 clusters → their
// member L0 observations — and counts `supportCount` and `sessionCount` off
// the observations it found. There is no `derivedFrom` field on a row here
// to drift, the banner cannot disagree with the store, and emptying
// `distillation-library-links` makes the drawer's "Distilled from" section
// disappear rather than go stale. `weight` is the CONFIDENCE OF THE CLUSTER
// the observation was merged into (an observation in two clusters takes the
// higher) — a number the L1 rows already carry, not a similarity score
// invented here to fill a field.
//
// AGE IS THE CLAIM, NOT THE DAY, so nothing below uses `keepWithinToday`:
// both the table column and the drawer render `updatedAt` through
// `relativeTime`, and no surface buckets an asset by calendar day. Same
// reasoning mock/promotions.ts records for its observation stamps.
//
// IDS AND WIRE STRINGS ARE NOT INVENTED. `kind` is PromptKind and `tier` is
// PromptTier (lib/prompt-contract.ts); `lifecycleStatus` values are the ones
// `observability.prompt_version_meta.lifecycle_status` carries; the seven
// asset ids that carry provenance are exactly the seven
// `library_item_id`s seedLibraryLinks() publishes into
// (mock/distillation.ts), which is what closes the loop in both directions.

import { clock, defineFixture } from './core/index.js';
import { artifacts, clusters, libraryLinks, observations } from './distillation.js';
import { promptEvalRuns } from './prompt-evals.js';
// Type-only, so it is erased at compile: providers/prompt-library.ts imports
// the fixture below at run time, and a value import back the other way would
// be a genuine cycle rather than a shared shape. Same pattern as
// mock/promotions.ts.
import type {
  DerivationSummary, LibraryAsset, LibraryAssetRow,
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

    // ── skill: the model discovers and loads it ──
    asset({
      id: 'skill-flaky-test-triage', name: 'Triage a flaky test',
      description: 'Use when a test passes and fails without a code change. Reruns, diffs the outcomes, and files a bug with both logs.',
      kind: 'skill', tier: 'internal', roles: ['sme'], tags: ['testing', 'runbook'],
      ownerName: 'Layla Hassan', version: '3', lifecycleStatus: 'published', evalPassRate: 0.89,
      usedBy: ['devbox', 'bot:obs-nightly-maintenance'], updatedAt: hoursAgo(14),
    }),
    asset({
      id: 'skill-cold-start-aurora', name: 'Recover a cold Aurora Data API',
      description: 'Use when the first Data API call after idle fails with HttpEndpointNotEnabled. Warms the endpoint and retries with backoff.',
      kind: 'skill', tier: 'internal', roles: ['sme', 'hr-admin'], tags: ['aurora', 'runbook', 'infra'],
      ownerName: 'Eli Garcia', version: '2', lifecycleStatus: 'published', evalPassRate: 0.97,
      usedBy: ['devbox'], updatedAt: hoursAgo(26),
    }),
    // The two procedures art-009 / art-011 were published as. They exist here
    // because every library link must resolve to a real asset — a link to an
    // id the catalog does not carry is a "Distilled from" section pointing at
    // a 404.
    asset({
      id: 'skill-sso-origin-bringup', name: 'Bring SSO up on a new origin',
      description: 'Use when standing Cognito SSO up on a new origin. Keeps the picker working until an HTTPS front door exists, then sets the callback in the order Cognito accepts.',
      kind: 'skill', tier: 'internal', roles: ['sme', 'hr-admin'], tags: ['auth', 'cognito', 'runbook'],
      ownerName: 'Mia Singh', version: '1', lifecycleStatus: 'published', evalPassRate: 0.91,
      usedBy: ['devbox'], updatedAt: hoursAgo(8),
    }),
    asset({
      id: 'skill-teardown-proposal', name: 'Propose an idle-capacity teardown',
      description: 'Use when proposing a teardown of idle capacity. Attributes the spend to the owning initiative and names the floor removed, so the case is approvable in one meeting.',
      kind: 'skill', tier: 'internal', roles: ['sme', 'org-leader'], tags: ['finops', 'runbook'],
      ownerName: 'Nora DaSilva', version: '1', lifecycleStatus: 'published', evalPassRate: 0.88,
      usedBy: ['devbox'], updatedAt: hoursAgo(6),
    }),
    asset({
      id: 'skill-pr-review-scoped', name: 'Review a PR diff-scoped',
      description: 'Use when reviewing a pull request. Comments only on changed lines and posts one risk summary.',
      kind: 'skill', tier: 'internal', roles: ['sme', 'program-owner'], tags: ['review', 'runbook'],
      ownerName: 'Caleb Turner', version: '1', lifecycleStatus: 'draft', evalPassRate: null,
      usedBy: [], updatedAt: hoursAgo(2), signoffs: 0,
      template: 'Review the pull request. Comment only on changed lines.',
    }),

    // ── insight: a fact injected, never run ──
    asset({
      id: 'insight-arm64-fargate', name: 'Fargate tasks here are ARM64',
      description: 'The middleware image is built on Apple Silicon; x86 tasks die with exec format error.',
      kind: 'insight', tier: 'internal', roles: ['sme', 'hr-admin'], tags: ['infra', 'gotcha'],
      ownerName: 'Eli Garcia', version: '1', lifecycleStatus: 'published',
      usedBy: ['devbox:SessionStart'], updatedAt: hoursAgo(96),
    }),
  ];
}

/**
 * The catalog.
 *
 * `default` — the ten-asset demo corpus above.
 * `empty`   — nothing published. Declared explicitly: an undeclared scenario
 *             falls back to `default`, and "the library is empty" is the one
 *             state a ten-asset seed can never show. It is also the world
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

/**
 * Where a Library asset came from, counted off the distillation store rather
 * than stored beside it.
 *
 * The walk is the lineage docs/distillation.md draws, read right to left:
 *
 *   library item ◀──published_as── artifact ◀──distilled_into── cluster ◀──merged_into── observation
 *
 * `undefined` (no "Distilled from" section at all) is the honest answer for
 * an asset nothing published into — a hand-written prompt, or a draft skill
 * — and it is also what an auditor sees after pinning
 * `distillation-library-links` to `empty`, which is the link running both
 * ways rather than a second copy of it.
 *
 * `fromKind` names the rung directly below: an artifact standing on L1
 * clusters was distilled from PATTERNS, one standing on none from raw
 * OBSERVATIONS. Every seeded artifact has at least one cluster, so the demo
 * corpus reports `pattern` throughout — that is the corpus telling the truth
 * about itself, not the field being constant.
 */
export function derivationFor(libraryItemId: string, topK = 3): DerivationSummary | undefined {
  const link = libraryLinks.rows().find((l) => l.library_item_id === libraryItemId);
  if (!link) return undefined;
  const artifact = artifacts.rows().find((a) => a.id === link.artifact_id);
  if (!artifact) return undefined;

  // observation id -> the confidence of the cluster it was merged into. An
  // observation carried by two of the artifact's clusters keeps the higher:
  // the strongest pattern it belongs to is the one that supports the claim.
  const weightByObservation = new Map<string, number>();
  let clusterCount = 0;
  for (const cluster of clusters.rows()) {
    if (!artifact.cluster_ids.includes(cluster.id)) continue;
    clusterCount += 1;
    for (const id of cluster.member_observation_ids) {
      weightByObservation.set(id, Math.max(weightByObservation.get(id) ?? 0, cluster.confidence));
    }
  }

  const supporting = observations.rows().filter((o) => weightByObservation.has(o.id));
  if (supporting.length === 0) return undefined;

  return {
    fromKind: clusterCount > 0 ? 'pattern' : 'observation',
    // Counted, never stored — the whole reason this function exists.
    supportCount: supporting.length,
    sessionCount: new Set(supporting.map((o) => o.session_id)).size,
    top: supporting
      .slice()
      // Strongest first; ties broken by id so the list is stable across reads
      // and a test can assert on it without depending on fixture order.
      .sort((a, b) =>
        (weightByObservation.get(b.id) ?? 0) - (weightByObservation.get(a.id) ?? 0)
        || a.id.localeCompare(b.id))
      .slice(0, topK)
      .map((o) => ({
        id: o.id,
        kind: o.kind,
        title: o.title,
        repo: o.repo,
        weight: weightByObservation.get(o.id) ?? 0,
      })),
  };
}

/** A stored row, decorated with the provenance the distillation store knows.
 *  This is the only place a `LibraryAsset` is assembled offline. */
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
    const derivedFrom = derivationFor(row.id);
    // Health & usage, Release readiness and the Evals panel used to disagree
    // on one asset's pass rate — the asset carried a seeded literal while the
    // panel read the latest run. The run corpus is the source; the seeded
    // figure stands only for an asset that has never been run.
    const fromRuns = latestRunRate(row.id, row.version);
    const evalPassRate = fromRuns === undefined ? row.evalPassRate : fromRuns;
    return derivedFrom ? { ...row, evalPassRate, derivedFrom } : { ...row, evalPassRate };
  });
}
