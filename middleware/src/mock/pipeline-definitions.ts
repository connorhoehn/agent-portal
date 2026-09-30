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

import { defineFixture } from './core/index.js';
import type { PipelineRunRecord, StoredDefinition } from '../lib/pipeline-definitions.js';

/** schema/pipeline_schema.sql's seed — the nine commands and the agent that runs each. */
const SEEDED_COMMANDS: Array<[name: string, owner: string]> = [
  ['classify-transcript', 'orgiq-assessment-scorer'],
  ['score-dimensions', 'orgiq-assessment-scorer'],
  ['process-self-assessment', 'orgiq-assessment-scorer'],
  ['develop-jira-story', 'orgiq-assessment-drafter'],
  ['extract-enterprise-context', 'orgiq-assessment-drafter'],
  ['validate-outputs', 'orgiq-assessment-drafter'],
  ['draft-confluence-page', 'orgiq-assessment-drafter'],
  ['suggest-confluence-content', 'orgiq-assessment-drafter'],
  ['draw-diagram', 'orgiq-assessment-drafter'],
];

export const pipelineDefinitionRows = defineFixture<StoredDefinition>({
  key: 'pipelines.definitions',
  scenarios: {
    default: () => SEEDED_COMMANDS.map(([name, owner]) => ({
      id: `assessment:${name}`, contextTenant: 'assessment', kind: 'assessment-command',
      title: name, owner, version: 1, approverRoles: [],
      sourceTable: 'assessment_commands', sourceId: name, updatedBy: null, updatedAt: null,
    })),
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
    default: () => [{ key: 'default_approver_role', value: 'operator', updatedBy: null }],
    empty: () => [],
  },
});
