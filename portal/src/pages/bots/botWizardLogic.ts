// Pure state/validation logic for BotCreateWizard — no React, no JSX, so it
// can be exercised directly by node:test. See `__tests__/botWizardLogic.test.ts`.

// ─── Step 1 — Template & mission ─────────────────────────────────────────────

export const TEMPLATES: Array<{ id: 'epic' | 'story' | 'bug'; label: string; blurb: string }> = [
  { id: 'epic', label: 'Epic', blurb: 'container — groups stories and bugs; never dispatched itself' },
  { id: 'story', label: 'Story', blurb: 'a sized change' },
  { id: 'bug', label: 'Bug', blurb: 'a defect with a repro' },
];

export interface Step1State { name: string; template: 'epic' | 'story' | 'bug' | null; prompt: string }
export interface Step1Errors { name?: string; template?: string; prompt?: string }

export function validateStep1(s: Step1State): Step1Errors {
  const errors: Step1Errors = {};
  if (!s.name.trim()) errors.name = 'Name is required.';
  else if (s.name.trim().length > 100) errors.name = 'Name must be 100 characters or fewer.';
  if (!s.template) errors.template = 'Pick a template.';
  if (!s.prompt.trim()) errors.prompt = 'The mission is required — a bot without one has nothing to do.';
  return errors;
}

// ─── Step 2 — Target ─────────────────────────────────────────────────────────

export interface Step2State { targetKind: 'codebase' | 'initiative'; agentProjectId: string; orgProjectId: string }
export interface Step2Errors { target?: string }

export function validateStep2(s: Step2State): Step2Errors {
  const errors: Step2Errors = {};
  if (s.targetKind === 'codebase' && !s.agentProjectId) errors.target = 'Pick a codebase.';
  if (s.targetKind === 'initiative' && !s.orgProjectId) errors.target = 'Pick an initiative.';
  return errors;
}

// ─── Step 3 — Guardrails ─────────────────────────────────────────────────────

export interface Step3State {
  model: string;
  budgetPerRunUsd: string;
  budgetPerDayUsd: string;
  maxRunsPerDay: number;
  requiresReview: boolean;
}
export interface Step3Errors { budgetPerRunUsd?: string; budgetPerDayUsd?: string; maxRunsPerDay?: string }

export function validateStep3(s: Step3State): Step3Errors {
  const errors: Step3Errors = {};
  const perRun = s.budgetPerRunUsd.trim();
  const perDay = s.budgetPerDayUsd.trim();
  if (perRun !== '' && (!Number.isFinite(Number(perRun)) || Number(perRun) <= 0)) {
    errors.budgetPerRunUsd = 'Must be a positive dollar amount, or empty for no cap.';
  }
  if (perDay !== '' && (!Number.isFinite(Number(perDay)) || Number(perDay) <= 0)) {
    errors.budgetPerDayUsd = 'Must be a positive dollar amount, or empty for no cap.';
  }
  if (!Number.isInteger(s.maxRunsPerDay) || s.maxRunsPerDay < 1) {
    errors.maxRunsPerDay = 'At least 1 run per day.';
  }
  return errors;
}

// ─── Step 4 — Trigger ────────────────────────────────────────────────────────

export const CRON_PRESETS: Array<{ label: string; expr: string }> = [
  { label: 'hourly', expr: '0 * * * *' },
  { label: 'daily 9am', expr: '0 9 * * *' },
  { label: 'weekly Mon 9am', expr: '0 9 * * 1' },
];

export interface Step4State { trigger: 'manual' | 'cron' | 'pr_watch'; cronExpr: string }
export interface Step4Errors { cronExpr?: string; trigger?: string }

export function validateStep4(s: Step4State, step2: Step2State): Step4Errors {
  const errors: Step4Errors = {};
  if (s.trigger === 'cron') {
    if (!s.cronExpr.trim()) errors.cronExpr = 'A cron expression is required.';
    else if (!/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(s.cronExpr.trim())) {
      errors.cronExpr = 'Five space-separated fields (min hour dom month dow).';
    }
  }
  if (s.trigger === 'pr_watch' && (step2.targetKind !== 'codebase' || !step2.agentProjectId)) {
    errors.trigger = 'On-new-PRs needs a codebase target — go back to step 2 and pick one.';
  }
  return errors;
}

// ─── Wizard shell ────────────────────────────────────────────────────────────

export const STEP_LABELS = ['Template', 'Target', 'Guardrails', 'Trigger', 'Review & launch'] as const;
