// The pipelines tenant's pages, as data (docs/social-tenant-design.md §5.3,
// docs/pipelines-tenant-goal.md).
//
// The registration half of lane P0 ships every page as an honest empty state:
// each one says what it will hold and which lane brings it. Pure data, no
// React, so `__tests__/pipelinesSurfaces.test.ts` runs under plain
// `node --test`. When a lane lands a surface (Runs and Artifacts are the rest
// of P0; Definitions, Runbooks and Approvals are P2), its route in App.tsx
// points at the real page and its row here goes.

export type PipelinesSurfaceId =
  | 'definitions' | 'runbooks' | 'runs' | 'approvals' | 'artifacts'
  | 'agents' | 'bots' | 'commands' | 'configuration';

export interface PipelinesSurface {
  id: PipelinesSurfaceId;
  /** Page title — the rail and palette label. */
  title: string;
  /** One line under the title: what this page is for. */
  description: string;
  /** The empty state's heading — what is not here yet. */
  emptyTitle: string;
  /** Why it is empty, in the reader's terms. */
  emptyBody: string;
  /** The lane (design §7) that brings this surface its data. */
  phase: 'P0' | 'P1' | 'P2';
  /** What that lane brings, one sentence. */
  next: string;
}

export const PIPELINES_SURFACES: Record<PipelinesSurfaceId, PipelinesSurface> = {
  definitions: {
    id: 'definitions',
    title: 'Definitions',
    description: 'What can run: every pipeline definition and its versions.',
    emptyTitle: 'No definitions yet',
    emptyBody: 'A definition says what a run does, step by step. Authors write them; none are registered here yet.',
    phase: 'P2',
    next: 'Lane P2 brings definitions — bots and assessment commands registered with their triggers.',
  },
  runbooks: {
    id: 'runbooks',
    title: 'Runbooks',
    description: 'Runbooks on their way to becoming skills.',
    emptyTitle: 'No runbooks yet',
    emptyBody: 'A runbook becomes a skill only after a completed dry-run of its definition. None are waiting.',
    phase: 'P2',
    next: 'Lane P2 brings runbook dry-runs, and promotion that refuses without one.',
  },
  runs: {
    id: 'runs',
    title: 'Runs',
    description: 'Every run, what it acted for, and where it stands.',
    emptyTitle: 'No runs to show yet',
    emptyBody: 'Runs from bots, agents and assessment commands will be listed here with their steps and status.',
    phase: 'P0',
    next: 'Lane P0 brings the run ledger, projected from the jobs, bot runs and commands that already exist.',
  },
  approvals: {
    id: 'approvals',
    title: 'Approvals',
    description: 'Steps waiting on a person to approve them.',
    emptyTitle: 'Nothing waiting on you',
    emptyBody: 'When a run reaches a step that needs a person, it waits here for an operator.',
    phase: 'P2',
    next: 'Lane P2 brings approvals, decided by an operator who did not write the definition.',
  },
  artifacts: {
    id: 'artifacts',
    title: 'Artifacts',
    description: 'What runs produced — changes, documents, scores and traces.',
    emptyTitle: 'No artifacts yet',
    emptyBody: 'Each run\'s outputs will be listed here, linked to the run that made them.',
    phase: 'P0',
    next: 'Lane P0 brings artifacts alongside the run ledger.',
  },
  agents: {
    id: 'agents',
    title: 'Agents',
    description: 'Agent invocations from every workspace, read as runs.',
    emptyTitle: 'No agent runs yet',
    emptyBody: 'Each agent invocation becomes a run, with its steps and its trace as an artifact.',
    phase: 'P1',
    next: 'Lane P1 carries the run id into every agent trace so each invocation lands here.',
  },
  bots: {
    id: 'bots',
    title: 'Bots',
    description: 'Scheduled maintenance bots, read as runs.',
    emptyTitle: 'No bot runs yet',
    emptyBody: 'A bot firing is the trigger of a run. Its history will be listed here.',
    phase: 'P0',
    next: 'Lane P0 brings bot firings through the run projection.',
  },
  commands: {
    id: 'commands',
    title: 'Commands',
    description: 'Assessment commands, read as runs.',
    emptyTitle: 'No command runs yet',
    emptyBody: 'Scoring and drafting commands from the assessment workspace will be listed here as runs.',
    phase: 'P0',
    next: 'Lane P0 brings assessment commands through the run projection.',
  },
  configuration: {
    id: 'configuration',
    title: 'Configuration',
    description: 'Who approves, how long runs are kept, and which sources feed the ledger.',
    emptyTitle: 'Nothing to configure yet',
    emptyBody: 'Settings appear here as the features they govern arrive. Only a pipeline admin can change them.',
    phase: 'P2',
    next: 'Lane P2 brings approver and retention settings.',
  },
};

export const PIPELINES_SURFACE_IDS = Object.keys(PIPELINES_SURFACES) as PipelinesSurfaceId[];
