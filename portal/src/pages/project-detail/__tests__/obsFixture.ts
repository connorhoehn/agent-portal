// A p-observability work tree shaped like the mockups (D1 titles, M2 brief
// fields) — shared by the Overview, Brief and composer model tests.

import type { ProjectDetail, WorkItemTree } from '../types.ts';

export function node(partial: Partial<WorkItemTree> & { id: string }): WorkItemTree {
  return {
    projectId: 'p-observability', projectName: 'Observability Platform', parentId: null, type: 'story', title: partial.id,
    description: null, status: 'open', priority: 'medium', assigneeId: null, assigneeName: null,
    assigneeDept: null, labels: [], storyPoints: null, prUrl: null, prStatus: null,
    createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', completedAt: null,
    childCount: 0, childDoneCount: 0, children: [],
    ...partial,
  };
}

const LAYLA = { assigneeId: 'p-008', assigneeName: 'Layla Hassan' };
const NORA = { assigneeId: 'p-004', assigneeName: 'Nora DaSilva' };
const ELI = { assigneeId: 'p-011', assigneeName: 'Eli Garcia' };

export const OBS_TREE: WorkItemTree[] = [
  node({
    id: 'wi-obs-e1', type: 'epic', title: 'OpenTelemetry everywhere',
    children: [
      node({ id: 'wi-obs-e1-s1', title: 'Roll out collector fleet', status: 'done', priority: 'critical', storyPoints: 8, ...LAYLA }),
      node({ id: 'wi-obs-e1-s2', title: 'Tail-sampling policy', status: 'done', priority: 'high', storyPoints: 5, ...NORA }),
      node({ id: 'wi-obs-e1-s3', title: 'Span-metrics connector', status: 'in_progress', priority: 'high', storyPoints: 8, ...LAYLA }),
      node({ id: 'wi-obs-e1-s4', title: 'Decommission the legacy StatsD bridge', summary: 'Move remaining service metrics to OpenTelemetry.', priority: 'medium', storyPoints: 5, ...LAYLA }),
      node({ id: 'wi-obs-e1-b5', type: 'bug', title: 'Collector OOMs under burst ingest', status: 'in_progress', priority: 'critical', storyPoints: 3, ...ELI }),
    ],
  }),
  node({
    id: 'wi-obs-e3', type: 'epic', title: 'Cost-aware telemetry',
    children: [
      node({ id: 'wi-obs-e3-s1', title: 'Metric cardinality budgets', summary: 'Define limits before new metrics increase storage costs.', storyPoints: 5, ...ELI }),
      node({ id: 'wi-obs-e3-s2', title: 'Tiered log sampling', storyPoints: 3, ...LAYLA }),
    ],
  }),
  node({
    id: 'wi-obs-e2', type: 'epic', title: 'SLOs and error budgets',
    children: [
      node({ id: 'wi-obs-e2-s1', title: 'SLO definitions', status: 'done', priority: 'high', storyPoints: 5, ...NORA }),
      node({ id: 'wi-obs-e2-s2', title: 'Multi-window burn-rate alerts', status: 'in_review', priority: 'high', storyPoints: 5, ...LAYLA }),
      node({ id: 'wi-obs-e2-s3', title: 'Error-budget dashboard per team', summary: "Make each team's remaining error budget visible.", storyPoints: 3, ...NORA }),
      node({
        id: 'wi-obs-e2-b4', type: 'bug', title: 'Stop duplicate alerts during a dependency outage', priority: 'high',
        labels: ['alerting', 'blocked'], storyPoints: 2, ...ELI,
        description: 'When one shared dependency fails, it can trigger forty separate pages.',
        summary: 'One failing dependency can trigger forty pages.',
        blockedReason: 'Eli needs the dependency map before this bug can be planned.',
        nextStep: 'Confirm the dependency map with Eli Garcia.',
        nextStepDetail: 'The team needs this before choosing how to group duplicate alerts.',
      }),
    ],
  }),
];

export const OBS_PROJECT: ProjectDetail = {
  id: 'p-observability', name: 'Observability Platform', status: 'in_progress', createdAt: null,
  ownerId: 'p-004', ownerName: 'Nora DaSilva',
  summary: 'Collect telemetry, reduce alert noise, and control retention costs.',
  agentSpendUsd: 1.73, allocatedUsd: 95, activeAgentRuns: 2,
  contributors: [
    { personId: 'p-004', name: 'Nora DaSilva', title: null, role: 'owner', weight: 1 },
    { personId: 'p-008', name: 'Layla Hassan', title: null, role: 'sme', weight: 0.8 },
    { personId: 'p-011', name: 'Eli Garcia', title: null, role: 'sme', weight: 0.8 },
  ],
};
