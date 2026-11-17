// The hiring manager's My openings page: the stage order it reads in and the
// counted stage tabs over its table.

import { candidateHref, type ApplicationStage } from './interviews.ts';

/** A hiring manager reads the pipeline from the decision end: debrief first, then who is interviewing. */
export const DECISION_ORDER: readonly ApplicationStage[] = ['debrief', 'offer', 'interviewing', 'screening', 'applied', 'on-hold', 'hired', 'rejected', 'withdrawn'];

/** A name always opens that person's record; the debrief has its own link in the row's result cell. */
export const pipelineNameHref = (row: { candidate: { id: string } }): string => candidateHref(row.candidate.id);

export interface StageTabs { all: number; stages: Array<{ stage: ApplicationStage; count: number }> }

/** One count per stage that has someone in it, in decision order, plus the total. */
export function stageTabs(rows: ReadonlyArray<{ stage: ApplicationStage }>): StageTabs {
  return {
    all: rows.length,
    stages: DECISION_ORDER.map((stage) => ({ stage, count: rows.filter((r) => r.stage === stage).length })).filter((s) => s.count > 0),
  };
}

/** The stage a typed filter names, or '' for all. */
export const stageFilterOf = (value: string): ApplicationStage | '' => (DECISION_ORDER as readonly string[]).includes(value) ? (value as ApplicationStage) : '';
