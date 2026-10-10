// The pipelines tenant's surface catalog — what the tenant's rail offers and
// which lane brings each surface its data (docs/social-tenant-design.md §5.3,
// §7; docs/pipelines-tenant-goal.md).
//
// The registration half of lane P0 ships every page as an honest empty state;
// the run projection (lib/pipeline-runs.ts) and the definitions tables (P2)
// bring the data. Until then this catalog is the one thing the tenant has rows
// for, so `GET /api/pipelines/summary` counts it (mock contract rule 1) — and
// `empty` shows the zero state without mutating anything (rule 4).
//
// Product metadata, not tenant data: live mode reads the same rows.

import { defineFixture } from './core/index.js';

/** A lane of the design's §7 table — the phase that gives a surface its data. */
export type PipelinesPhase = 'P0' | 'P1' | 'P2';

export interface PipelinesSurface {
  /** The route segment under /pipelines. */
  id: string;
  label: string;
  /** Rail group (GROUP_ORDER_BY_TENANT.pipelines in the portal). */
  group: 'Catalog' | 'Runs' | 'Sources' | 'System';
  phase: PipelinesPhase;
  /** True once the surface reads real rows (Runs and Artifacts: the run projection, lane P0;
   *  Definitions, Runbooks, Approvals and the three Sources lists: lane P2). */
  live: boolean;
}

export const pipelinesSurfaces = defineFixture<PipelinesSurface>({
  key: 'pipelines.surfaces',
  scenarios: {
    default: () => [
      { id: 'definitions', label: 'Definitions', group: 'Catalog', phase: 'P2', live: true },
      { id: 'runbooks', label: 'Runbooks', group: 'Catalog', phase: 'P2', live: true },
      { id: 'queues', label: 'Queues', group: 'Runs', phase: 'P2', live: true },
      { id: 'runs', label: 'Runs', group: 'Runs', phase: 'P0', live: true },
      { id: 'approvals', label: 'Approvals', group: 'Runs', phase: 'P2', live: true },
      { id: 'artifacts', label: 'Artifacts', group: 'Runs', phase: 'P0', live: true },
      { id: 'agents', label: 'Agents', group: 'Sources', phase: 'P1', live: true },
      { id: 'bots', label: 'Bots', group: 'Sources', phase: 'P0', live: true },
      { id: 'commands', label: 'Commands', group: 'Sources', phase: 'P0', live: true },
      { id: 'configuration', label: 'Configuration', group: 'System', phase: 'P2', live: false },
    ],
    empty: () => [],
  },
});

/** Surfaces, counted — a selector, never a stored number. */
export function pipelinesSurfaceCounts(rows: PipelinesSurface[] = pipelinesSurfaces.rows()): { total: number; live: number; pending: number } {
  const live = rows.filter((r) => r.live).length;
  return { total: rows.length, live, pending: rows.length - live };
}
