// Cross-fixture id references, checked for real.
//
// Two seeded org-findings rows (find-mock-5, find-mock-6) named decision ids
// ('dec-cognito-hosted-ui', 'dec-titan-1024') that mock/decisions.ts has never
// had — the Explore → Findings deep link joined on the id and always landed on
// "Nothing here". Nothing caught it because every fixture is free-standing
// TypeScript: the compiler checks that a field is a `string`, never that the
// string is a row that exists somewhere else. That is one bug class —
// cross-fixture id references that resolve nowhere — and it is not confined
// to org-findings; the same walk below also caught it in mock/lab.ts,
// mock/promotions.ts and mock/sprints.ts (see the fixes alongside this test).
//
// WHAT THIS DOES. Every mock/*.ts fixture module is required so it registers
// with the shared `fixtureRegistry` (mirroring what a live `dev:mock` process
// has done by the time `GET /api/__mock/state` answers — nothing here is
// walked until its module has actually run). Every fixture's `default`-
// scenario rows are then walked recursively, and any field whose NAME appears
// in the resolver table below is checked against the fixture that is the
// source of truth for that id shape. The table is explicit — keyed by field
// name to a specific target universe — rather than inferred from a prefix,
// because a few field names are legitimately overloaded: `ownerId` means an
// org-graph person in org-findings evidence and an app_user identity
// ('demo-user') in local-compute.ts, and `projectId` means an org initiative
// slug in decisions.ts/work-items.ts but an `agent_projects` UUID in
// agent-project-runs.ts/sdlc.ts. Both are handled by branching on the VALUE's
// shape rather than trusting the field name alone — which is also how a
// person id (`p-019`) and an initiative id (`p-observability`) are told apart
// despite sharing the `p-` prefix.
//
// SKIPPED, ON PURPOSE (not silently — each line says why):
//   * `Finding.entityId` when `entityType === 'document'` — the org graph's
//     `documents` table has no offline mirror; nothing in mock/ could resolve
//     it.
//   * `Finding.entityId` when `entityType === 'repo'` — the one seeded row
//     (find-mock-7, entityId 'orgiq-portal') is a devbox lab-signal finding
//     about the ACTUAL developer repos (aws-agentcore, orgiq-portal) this
//     project runs on, not the synthetic `connorhoehnslalom/orgiq-*` cast
//     mock/github.ts and mock/agent-projects.ts model. See also lab.ts's
//     `repo: 'aws-agentcore'` rows below.
//   * `LabExperience.repo` / `LabConsult.repo` / `Observation.repo` — same
//     reason: devbox/lab-loop rows are about this real repo, not the
//     synthetic demo cast, so they are never checked against
//     github-repos/agent-projects.
//   * `SeededCandidate.driftedFrom` ('skl-custodian-sg-allowlist') — the id of
//     a skill that drift detection demoted back to a runbook. The row is a
//     historical pointer to a skill that no longer exists in
//     mock/prompt-library.ts (that's the whole point of the narrative), and
//     the literal string is pinned by
//     providers/__tests__/promotions.test.ts, so it must not be "fixed" into
//     resolving.
//   * `Finding.jobId` / `BotRun.jobId` ('job-<slug>-maint-N') — references the
//     `agent_jobs` table, which has no registered fixture at all (no fixture
//     anywhere declares a job's row shape), so there is nothing to resolve
//     against.
//   * `ReviewRow.reviewer` / `ChangeRow.decidedBy` / local-compute's `ownerId`
//     values like 'u-nora', 'agent', 'demo-user' — an `app_user` identity or a
//     literal, not an org-graph person id. Handled by shape-gating rather than
//     a name-based skip: `ownerId`/`answeredBy`/`dispatchedBy` are only
//     checked when the value actually looks like a person id (`p-0NN`); a
//     value in a different id space is left alone.

import * as fs from 'node:fs';
import * as path from 'node:path';

// The require-everything loop below pulls in every mock/*.ts file, including
// several that import config.js at module scope — which uses `import.meta`
// and cannot load under ts-jest's CommonJS transform (TS1343). Real config
// pulls no fixture rows anywhere; mocked out the same way
// domain-fixture-writes.test.ts and schema-shape.test.ts already do.
jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, cloudwatch: true, guardrails: false }, aurora: {} },
}));

// Every mock/*.ts fixture module, required for its side effect (registering
// with fixtureRegistry) before anything below reads `.all()`. This is the
// same requirement `GET /api/__mock/state` has in a live process — a fixture
// nothing has imported is invisible to the registry there too.
const MOCK_DIR = path.resolve(__dirname, '..');
for (const file of fs.readdirSync(MOCK_DIR)) {
  if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require(path.join(MOCK_DIR, file));
}

import { fixtureRegistry } from '../core/index.js';
import { seededPeople } from '../people.js';
import { mockSkills } from '../graph-taxonomy.js';
import { decisionRows } from '../decisions.js';
import { initiativeBudgets } from '../budgets.js';
import { bots } from '../bots.js';
import { workItems } from '../work-items.js';
import { sprints } from '../sprints.js';
import { teamsFixture } from '../assessment.js';
import { githubRepoRows } from '../github.js';
import { agentProjects } from '../agent-projects.js';
import { libraryAssets } from '../prompt-library.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// ── Universes: every fixture that is a source of truth for an id shape ─────

const personIds = new Set(seededPeople.map((p) => p.id));
const skillIds = new Set(mockSkills.map((s) => s.id));
const decisionIds = new Set(decisionRows.rows('default').map((d) => d.id));
const initiativeIds = new Set(initiativeBudgets.rows('default').map((b) => b.id));
const botIds = new Set(bots.rows('default').map((b) => b.id));
const workItemIds = new Set(workItems.rows('default').map((w) => w.id));
const sprintIds = new Set(sprints.rows('default').map((s) => s.id));
const teamIds = new Set(teamsFixture.rows('default').map((t) => t.id));
const agentProjectUuids = new Set(agentProjects.rows('default').map((p) => p.id));
const libraryAssetIds = new Set(libraryAssets.rows('default').map((a) => a.id));
const repoFullNames = new Set([
  ...githubRepoRows.rows('default').map((r) => r.fullName),
  ...agentProjects.rows('default').map((p) => p.repoFullName),
]);

const PERSON_ID_RE = /^p-\d{3}$/;
const INITIATIVE_ID_RE = /^p-[a-z]/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── The resolver table: field name → what it must resolve against ──────────
//
// `onlyInFixture`, when set, restricts the check to one fixture key — used
// for the couple of field names that are unambiguous FKs in one fixture and
// free text in another (see `initiative` below).

interface Resolver {
  target: string;
  /** true = resolves (or is legitimately not applicable to this value). */
  ok(value: string): boolean;
  onlyInFixture?: string;
}

const person: Resolver = { target: 'a person id in mock/people.ts', ok: (v) => personIds.has(v) };
/** Shape-gated: `ownerId` et al. are only person ids WHEN they look like one
 *  (`p-0NN`) — local-compute.ts's `ownerId` is an app_user identity
 *  ('demo-user', 'u-operator') and is correctly left alone here. */
const personIfShaped: Resolver = {
  target: 'a person id in mock/people.ts',
  ok: (v) => !PERSON_ID_RE.test(v) || personIds.has(v),
};
const initiative: Resolver = { target: 'an initiative id in mock/budgets.ts', ok: (v) => initiativeIds.has(v) };
const decision: Resolver = { target: 'a decision id in mock/decisions.ts', ok: (v) => decisionIds.has(v) };
const bot: Resolver = { target: 'a bot id in mock/bots.ts', ok: (v) => botIds.has(v) };
const workItem: Resolver = { target: 'a work item id in mock/work-items.ts', ok: (v) => workItemIds.has(v) };
const sprint: Resolver = { target: 'a sprint id in mock/sprints.ts', ok: (v) => sprintIds.has(v) };
const team: Resolver = { target: 'a team id in mock/assessment.ts', ok: (v) => teamIds.has(v) };
const repoFullName: Resolver = { target: 'a repo full name in mock/github.ts or mock/agent-projects.ts', ok: (v) => repoFullNames.has(v) };
const libraryAsset: Resolver = { target: 'a library asset id in mock/prompt-library.ts', ok: (v) => libraryAssetIds.has(v) };
const agentProjectId: Resolver = { target: 'an agent_projects uuid in mock/agent-projects.ts', ok: (v) => agentProjectUuids.has(v) };
/** `projectId` is overloaded: an initiative slug (decisions.ts, work-items.ts,
 *  local-compute.ts) or an `agent_projects` uuid (agent-project-runs.ts,
 *  sdlc.ts) — branch on the value's own shape rather than the field name. */
const projectIdEither: Resolver = {
  target: 'an initiative id (mock/budgets.ts) or an agent_projects uuid (mock/agent-projects.ts)',
  ok: (v) => (UUID_RE.test(v) ? agentProjectUuids.has(v) : INITIATIVE_ID_RE.test(v) ? initiativeIds.has(v) : true),
};

const FIELD_RESOLVERS: Record<string, Resolver> = {
  personId: person,
  granteePersonId: person,
  assigneeId: person,
  stewardPersonId: person,
  answeredBy: personIfShaped,
  dispatchedBy: personIfShaped,
  ownerId: personIfShaped,
  holderIds: person,
  decisionId: decision,
  botId: bot,
  workItemId: workItem,
  parentId: workItem,
  sprintId: sprint,
  team_id: team,
  repoFullName,
  library_item_id: libraryAsset,
  assetId: libraryAsset,
  agentProjectId,
  initiativeId: initiative,
  orgProjectId: initiative,
  candidateInitiative: initiative,
  linkedTo: initiative,
  initiatives: initiative,
  projectId: projectIdEither,
  // Free text everywhere except org-findings evidence ("MLOps is held by...
  // p-observability"); prompt-evals.ts uses the same field name for an eval
  // case's subject line ("Aurora migration"), which is not an id at all.
  initiative: { ...initiative, onlyInFixture: 'org-findings' },
};

// Findings carry their subject as (entityType, entityId) rather than a named
// field, so it needs its own branch instead of a table entry.
const ENTITY_ID_RESOLVER: Partial<Record<string, Resolver | null>> = {
  decision,
  skill: { target: 'a skill id in mock/graph-taxonomy.ts', ok: (v) => skillIds.has(v) },
  // No documents fixture exists offline, and the one seeded repo finding
  // points at a real project repo, not the synthetic cast — see the header.
  document: null,
  repo: null,
};

// ── The walk ─────────────────────────────────────────────────────────────

function checkValue(resolver: Resolver, value: Json, path: string, fixtureKey: string, failures: string[]): void {
  if (resolver.onlyInFixture && resolver.onlyInFixture !== fixtureKey) return;
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkValue(resolver, v, `${path}[${i}]`, fixtureKey, failures));
    return;
  }
  if (typeof value !== 'string' || value === '') return;
  if (!resolver.ok(value)) {
    failures.push(`${path} → ${JSON.stringify(value)}  (expected ${resolver.target})`);
  }
}

function walk(value: Json, path: string, fixtureKey: string, failures: string[]): void {
  if (value === null || value === undefined || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => walk(v, `${path}[${i}]`, fixtureKey, failures));
    return;
  }
  const obj = value as Record<string, Json>;
  if (fixtureKey === 'org-findings' && typeof obj['entityId'] === 'string' && typeof obj['entityType'] === 'string') {
    const entityType = obj['entityType'] as string;
    const resolver = ENTITY_ID_RESOLVER[entityType];
    if (resolver === undefined) {
      failures.push(`${path}.entityType → ${JSON.stringify(entityType)}  (no resolver declared — add one or an explicit skip)`);
    } else if (resolver !== null) {
      checkValue(resolver, obj['entityId'], `${path}.entityId`, fixtureKey, failures);
    }
  }
  for (const [key, v] of Object.entries(obj)) {
    if (fixtureKey === 'org-findings' && key === 'entityId') continue; // handled above
    const resolver = FIELD_RESOLVERS[key];
    if (resolver) checkValue(resolver, v, `${path}.${key}`, fixtureKey, failures);
    walk(v, `${path}.${key}`, fixtureKey, failures);
  }
}

describe('every fixture-to-fixture id reference resolves', () => {
  it('finds no dangling reference across the registered fixtures', () => {
    expect(fixtureRegistry.size()).toBeGreaterThan(40); // sanity: the require loop above actually worked

    const failures: string[] = [];
    for (const fixture of fixtureRegistry.all()) {
      const rows = fixture.rows('default') as unknown as Json[];
      rows.forEach((row, i) => {
        const r = row as unknown as Record<string, Json>;
        const rowId = typeof r?.['id'] === 'string' ? (r['id'] as string) : `#${i}`;
        walk(row, `${fixture.key}.${rowId}`, fixture.key, failures);
      });
    }

    if (failures.length > 0) {
      throw new Error(
        `${failures.length} dangling fixture reference(s):\n` + failures.map((f) => `  ${f}`).join('\n'),
      );
    }
  });
});
