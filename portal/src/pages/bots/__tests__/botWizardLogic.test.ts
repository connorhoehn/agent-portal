// Run with:  cd portal && node --test 'src/pages/bots/__tests__/*.test.ts'

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateStep1,
  validateStep2,
  validateStep3,
  validateStep4,
  type Step1State,
  type Step2State,
  type Step3State,
  type Step4State,
} from '../botWizardLogic.ts';

const step1Base: Step1State = { name: '', template: null, prompt: '' };

test('validateStep1 requires a name, a template and a mission', () => {
  const errors = validateStep1(step1Base);
  assert.equal(errors.name, 'Name is required.');
  assert.equal(errors.template, 'Pick a template.');
  assert.equal(errors.prompt, 'The mission is required — a bot without one has nothing to do.');
});

test('validateStep1 rejects a name over 100 characters', () => {
  const errors = validateStep1({ ...step1Base, name: 'x'.repeat(101), template: 'bug', prompt: 'do it' });
  assert.equal(errors.name, 'Name must be 100 characters or fewer.');
});

test('validateStep1 passes with trimmed, valid fields', () => {
  const errors = validateStep1({ name: '  Tech-debt hunter  ', template: 'bug', prompt: '  hunt bugs  ' });
  assert.deepEqual(errors, {});
});

const step2Base: Step2State = { targetKind: 'codebase', agentProjectId: '', orgProjectId: '' };

test('validateStep2 requires a codebase when target kind is codebase', () => {
  assert.equal(validateStep2(step2Base).target, 'Pick a codebase.');
});

test('validateStep2 requires an initiative when target kind is initiative', () => {
  assert.equal(validateStep2({ ...step2Base, targetKind: 'initiative' }).target, 'Pick an initiative.');
});

test('validateStep2 passes once the matching target is picked', () => {
  assert.deepEqual(validateStep2({ ...step2Base, agentProjectId: 'ap-1' }), {});
  assert.deepEqual(validateStep2({ targetKind: 'initiative', agentProjectId: '', orgProjectId: 'op-1' }), {});
});

const step3Base: Step3State = {
  model: 'nova-pro', budgetPerRunUsd: '', budgetPerDayUsd: '', maxRunsPerDay: 4, requiresReview: true,
};

test('validateStep3 allows empty budgets (no cap) but rejects non-positive ones', () => {
  assert.deepEqual(validateStep3(step3Base), {});
  assert.equal(validateStep3({ ...step3Base, budgetPerRunUsd: '0' }).budgetPerRunUsd, 'Must be a positive dollar amount, or empty for no cap.');
  assert.equal(validateStep3({ ...step3Base, budgetPerRunUsd: 'abc' }).budgetPerRunUsd, 'Must be a positive dollar amount, or empty for no cap.');
  assert.equal(validateStep3({ ...step3Base, budgetPerDayUsd: '-5' }).budgetPerDayUsd, 'Must be a positive dollar amount, or empty for no cap.');
});

test('validateStep3 requires at least 1 integer run per day', () => {
  assert.equal(validateStep3({ ...step3Base, maxRunsPerDay: 0 }).maxRunsPerDay, 'At least 1 run per day.');
  assert.equal(validateStep3({ ...step3Base, maxRunsPerDay: 1.5 }).maxRunsPerDay, 'At least 1 run per day.');
});

const step4Base: Step4State = { trigger: 'manual', cronExpr: '' };

test('validateStep4 requires a well-formed cron expression when trigger is cron', () => {
  assert.equal(validateStep4({ trigger: 'cron', cronExpr: '' }, step2Base).cronExpr, 'A cron expression is required.');
  assert.equal(
    validateStep4({ trigger: 'cron', cronExpr: 'not a cron' }, step2Base).cronExpr,
    'Five space-separated fields (min hour dom month dow).',
  );
  assert.deepEqual(validateStep4({ trigger: 'cron', cronExpr: '0 9 * * *' }, step2Base), {});
});

test('validateStep4 requires a codebase target for pr_watch', () => {
  assert.equal(
    validateStep4({ trigger: 'pr_watch', cronExpr: '' }, step2Base).trigger,
    'On-new-PRs needs a codebase target — go back to step 2 and pick one.',
  );
  assert.deepEqual(
    validateStep4({ trigger: 'pr_watch', cronExpr: '' }, { ...step2Base, agentProjectId: 'ap-1' }),
    {},
  );
});

test('validateStep4 has no requirements for manual', () => {
  assert.deepEqual(validateStep4(step4Base, step2Base), {});
});
