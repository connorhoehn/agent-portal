// The assessment collections' command composers: each page's bounded grammar
// over the same controlled toolbar state it already shows (search, one
// filter, refresh, reset) and, where a row opens a record, `open` by exact ID
// or title over the CURRENT filtered rows. Nothing here writes, scores,
// publishes or hands text to an agent.
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import { collectionCommandAdapter, resolveCollectionTarget } from '../../components/collections/collectionCommands.ts';

type Cohort = 'white_glove' | 'self_service' | 'general';
type FeedbackStatus = 'OPEN' | 'RESOLVED' | 'DISMISSED' | 'ALL';

/** Motion phrase → `?cohort=` value: the desk's own motion control. */
export const TEAM_MOTION_FILTERS: Record<string, Cohort> = {
  'white glove': 'white_glove',
  'self service': 'self_service',
  general: 'general',
};

export function teamsCommandAdapter(rows: ReadonlyArray<{ id: string; name: string }>, controls: {
  setQuery(value: string): void;
  setMotion(value: Cohort | 'all'): void;
  clearStatus(): void;
  refresh(): void;
  openTeam(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'teams', filters: TEAM_MOTION_FILTERS }, {
    id: 'assessment-teams-commands',
    setQuery: controls.setQuery,
    setFilter(value) {
      if (value === '') { controls.setMotion('all'); controls.clearStatus(); return; }
      controls.setMotion(value as Cohort);
    },
    refresh: controls.refresh,
    scopeNote: 'Search matches loaded team names and IDs; motion filters the desk. Open uses one exact visible team ID or name. Commands never create, score or change a team.',
    open(target) {
      const team = resolveCollectionTarget(target, rows.map((t) => ({ id: t.id, title: t.name })));
      controls.openTeam(team.id);
      return `Opened ${team.title}.`;
    },
  });
}

export function submissionsCommandAdapter(controls: { setQuery(value: string): void; refresh(): void }): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'submissions' }, {
    id: 'assessment-submissions-commands',
    setQuery: controls.setQuery,
    refresh: controls.refresh,
    scopeNote: 'Search matches loaded submissions by team, form, envelope, submitter and status. Commands never add, delete or clear submissions.',
  });
}

export function reportsCommandAdapter(controls: { setQuery(value: string): void; setMotion(value: Cohort | 'all'): void; refresh(): void }): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'teams', filters: TEAM_MOTION_FILTERS }, {
    id: 'assessment-heatmap-commands',
    label: 'Heatmap',
    setQuery: controls.setQuery,
    setFilter: (value) => controls.setMotion(value === '' ? 'all' : value as Cohort),
    refresh: controls.refresh,
    scopeNote: 'Search and motion narrow the heatmap rows by loaded team name or ID. Commands never publish the report or change a score.',
  });
}

export const FEEDBACK_STATUS_FILTERS: Record<string, FeedbackStatus> = {
  open: 'OPEN',
  answered: 'RESOLVED',
  dismissed: 'DISMISSED',
  'any status': 'ALL',
};

export function feedbackCommandAdapter(rows: ReadonlyArray<{ task_id: string; question: string }>, controls: {
  setQuery(value: string): void;
  setStatus(value: FeedbackStatus): void;
  clearTeam(): void;
  refresh(): void;
  openQuestion(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter({ noun: 'questions', filters: FEEDBACK_STATUS_FILTERS }, {
    id: 'assessment-feedback-commands',
    setQuery: controls.setQuery,
    setFilter(value) {
      if (value === '') { controls.setStatus('OPEN'); controls.clearTeam(); return; }
      controls.setStatus(value as FeedbackStatus);
    },
    refresh: controls.refresh,
    scopeNote: 'Search matches loaded questions, dimensions and teams; status changes which questions are read. Open uses one exact visible task ID or question. Commands never answer or dismiss a question.',
    open(target) {
      const task = resolveCollectionTarget(target, rows.map((t) => ({ id: t.task_id, title: t.question })));
      controls.openQuestion(task.id);
      return 'Opened the question. Answering stays in its drawer.';
    },
  });
}
