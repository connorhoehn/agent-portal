// The pipelines tenant's own rows, offline — what schema/pipeline_schema.sql
// stores (docs/pipelines-tenant-goal.md §P2).
//
// Three registered fixtures, so every write here is undone by
// `POST /api/__mock/reset` and every page can be shown empty on request:
//
//   pipelines.definitions  `pipeline_definitions` — the RECORDED versions of
//                          definitions. The definitions themselves are derived
//                          (lib/pipeline-definitions.ts) from the bots, agents,
//                          commands and promotion-candidate fixtures; a row
//                          here is only what an author recorded over one. The
//                          default mirrors the SQL seed exactly: the nine
//                          assessment commands at version 1, owned by the agent
//                          that runs each. The parity entity
//                          'pipeline_definitions' pins it.
//   pipelines.runs         `pipeline_runs` — runs this tenant started (the
//                          runbook dry-run). Seeded EMPTY on purpose: no dry-run
//                          has ever been recorded, and inventing one would put
//                          a run id on a promotion verdict that no job ever ran.
//                          The first row arrives when someone presses Dry-run.
//   pipelines.config       `pipeline_config` — the default approver role.
//
// No counts are stored anywhere here (mock contract rule 1): a definition's
// run count and last run are selected from the projection per read.

import { clock, defineFixture } from './core/index.js';
import { humanizeSlug } from '../lib/pipeline-run-titles.js';
import type { PipelineRunRecord, StoredDefinition } from '../lib/pipeline-definitions.js';

/**
 * schema/pipeline_schema.sql's seed — the nine commands, each recorded by Ines
 * Moreau (the pipelines author): her version, the operator role approving its
 * steps. The agent that runs a command is the registry's derivation
 * (commandOwner), not the definition's owner.
 */
const SEEDED_RUNBOOKS: Array<[candidate: string, title: string]> = [
  ['promo-aurora-cold-start', 'Resume a nightly ingest from its last checkpoint'],
  ['promo-arm64-fargate', 'Quarantine a malformed batch instead of failing the whole load'],
  ['promo-custodian-sg-drift', 'Backfill a month of events without duplicating rows'],
];
const SEEDED_COMMANDS: string[] = [
  'classify-transcript', 'score-dimensions', 'process-self-assessment', 'develop-jira-story',
  'extract-enterprise-context', 'validate-outputs', 'draft-confluence-page', 'suggest-confluence-content', 'draw-diagram',
];

export const pipelineDefinitionRows = defineFixture<StoredDefinition>({
  key: 'pipelines.definitions',
  scenarios: {
    default: () => [
      ...SEEDED_COMMANDS.map((name, i): StoredDefinition => ({
        id: `assessment:${name}`, contextTenant: 'assessment', kind: 'assessment-command',
        title: humanizeSlug(name), owner: 'u-ines', version: 1, approverRoles: ['operator'],
        sourceTable: 'assessment_commands', sourceId: name, updatedBy: 'u-ines', updatedAt: clock.daysAgo(30 + i * 4),
      })),
      // The three runbooks on the ladder are Ines's too: she wrote the procedures the fleet learned.
      ...SEEDED_RUNBOOKS.map(([candidate, title], i): StoredDefinition => ({
        id: `runbook:${candidate}`, contextTenant: 'orgiq', kind: 'runbook', title, owner: 'u-ines', version: 1, approverRoles: ['operator'],
        sourceTable: 'promotion_candidates', sourceId: candidate, updatedBy: 'u-ines', updatedAt: clock.daysAgo(14 + i * 6),
      })),
    ],
    empty: () => [],
    error: () => { throw new Error('pipeline_definitions unavailable: relation does not exist'); },
  },
});

export const pipelineRunRecords = defineFixture<PipelineRunRecord>({
  key: 'pipelines.runs',
  scenarios: {
    default: () => [],
    empty: () => [],
    error: () => { throw new Error('pipeline_runs unavailable: relation does not exist'); },
  },
});

export interface PipelineConfigRow { key: string; value: unknown; updatedBy: string | null }

export const pipelineConfigRows = defineFixture<PipelineConfigRow>({
  key: 'pipelines.config',
  scenarios: {
    default: () => [{ key: 'default_approver_role', value: 'operator', updatedBy: 'u-dara' }],
    empty: () => [],
  },
});
