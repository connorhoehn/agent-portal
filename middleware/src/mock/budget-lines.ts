// The organisation's budget lines, offline — `learning_budget`
// (schema/budget_lines_schema.sql).
//
// One stored value: the monthly cap for server-side distillation, when an org
// leader has set one. Empty by default, so the cap reads as the deployment
// default (LEARNING_BUDGET_USD, lib/learning-budget.ts) until someone sets it,
// and `POST /api/__mock/reset` puts it back.

import { defineFixture } from './core/index.js';

export interface LearningBudgetRow {
  id: 'org';
  monthlyCapUsd: number;
  updatedBy: string | null;
  updatedAt: string;
}

export const learningBudget = defineFixture<LearningBudgetRow>({
  key: 'learning-budget',
  scenarios: {
    default: () => [],
    empty: () => [],
    error: () => { throw new Error('learning_budget unavailable: relation does not exist'); },
  },
});
