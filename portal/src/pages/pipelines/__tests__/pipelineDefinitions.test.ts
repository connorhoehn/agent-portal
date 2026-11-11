// Run with:  cd portal && node --test 'src/pages/pipelines/__tests__/*.test.ts'
//
// The labels the Definitions, Runbooks, Approvals and Sources pages share
// (lib/pipelineDefinitions.ts): the default approver is named as a default,
// the client's decide check mirrors the server's, rule 1 reads in words, and
// each Sources page lists exactly one definition kind.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  approverSummary, canDecide, canDryRun, definitionHref, promotionVerdict, rungLabel, triggerSummary,
  SOURCE_KINDS, DEFINITION_KIND_OPTIONS, approvalSourceLabel, brakesNote, matchesDefinition,
} from '../../../lib/pipelineDefinitions.ts';

test('an approver nobody named reads as the default', () => {
  assert.equal(approverSummary(['operator'], true), 'Operator (default)');
  assert.equal(approverSummary(['pipeline-admin'], false), 'Pipeline admin');
  assert.equal(approverSummary(['operator', 'pipeline-admin'], false), 'Operator or Pipeline admin');
});

test('the client decide check mirrors the server: admins decide anything, authors nothing', () => {
  assert.equal(canDecide('operator', ['operator']), true);
  assert.equal(canDecide('operator', ['pipeline-admin']), false);
  assert.equal(canDecide('pipeline-admin', ['operator']), true);
  assert.equal(canDecide('admin', ['operator']), true);
  assert.equal(canDecide('author', ['operator']), false);
  assert.equal(canDecide(null, ['operator']), false);
});

test('rule 1 in words: a completed run allows, anything else names why not', () => {
  assert.deepEqual(promotionVerdict({ proposedKind: 'skill', candidateStatus: 'candidate', promotionToSkill: { ok: true, runId: 'job:1' } }).tone, 'success');
  const refused = promotionVerdict({ proposedKind: 'skill', candidateStatus: 'candidate', promotionToSkill: { ok: false, reason: 'a skill needs a completed dry-run' } });
  assert.equal(refused.tone, 'warning');
  assert.match(refused.detail, /completed dry-run/);
  assert.equal(promotionVerdict({ proposedKind: 'skill', candidateStatus: 'promoted', promotionToSkill: { ok: false, reason: 'x' } }).label, 'Already a skill');
  assert.equal(rungLabel({ proposedKind: 'skill', candidateStatus: 'approved' }), 'Proposed workflow · approved');
  assert.equal(rungLabel({ proposedKind: 'runbook', candidateStatus: 'candidate' }), 'Workflow');
});

test('only an enabled runbook offers a dry-run', () => {
  assert.equal(canDryRun({ kind: 'runbook', enabled: true }), true);
  assert.equal(canDryRun({ kind: 'runbook', enabled: false }), false);
  assert.equal(canDryRun({ kind: 'bot', enabled: true }), false);
});

test('each Sources page lists one definition kind, all four kinds are filterable', () => {
  assert.deepEqual(Object.values(SOURCE_KINDS).sort(), ['agent', 'assessment-command', 'bot']);
  assert.deepEqual(DEFINITION_KIND_OPTIONS.map((o) => o.value), ['', 'runbook', 'bot', 'assessment-command', 'agent']);
});

test('triggers, links and sources read as words', () => {
  assert.equal(triggerSummary([{ type: 'schedule', detail: 'cron 0 3 * * *' }, { type: 'manual', detail: 'by hand' }]), 'Schedule · Manual');
  assert.equal(triggerSummary([]), 'none');
  assert.equal(definitionHref('runbook:promo-a'), '/pipelines/definitions/runbook%3Apromo-a');
  assert.equal(approvalSourceLabel('lab_consults'), 'Agent question');
  assert.equal(brakesNote([]), '');
  assert.match(brakesNote(['run budget: none requested']), /^Brakes: run budget/);
});

test('the catalog search reads title, id, owner and description', () => {
  const d = { title: 'nightly-dependency-audit', id: 'bot:abc', owner: 'u-nora', description: 'Audit dependencies' };
  assert.equal(matchesDefinition(d, ''), true);
  assert.equal(matchesDefinition(d, 'NIGHTLY'), true);
  assert.equal(matchesDefinition(d, 'bot:abc'), true);
  assert.equal(matchesDefinition(d, 'u-nora'), true);
  assert.equal(matchesDefinition(d, 'audit dep'), true);
  assert.equal(matchesDefinition(d, 'zzzz'), false);
});
