import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initiativeAgentBody, initiativeAgentRequest } from '../initiativeAgentRequest.ts';
import { briefFacts } from '../../project-detail/briefModel.ts';
import { workRows } from '../../project-detail/workListModel.ts';
import { OBS_PROJECT, OBS_TREE } from '../../project-detail/__tests__/obsFixture.ts';

const item = workRows(OBS_TREE, 'priority', '').find(row => row.id === 'wi-obs-e2-b4')!;
const subject = { kind: 'item' as const, project: { ...OBS_PROJECT }, item: { ...item, key: 'ORG-OBS-11' }, facts: briefFacts(item, { data: [] }) };

test('a run carries only typed IDs and snapshots the originating work context', () => {
  const request = initiativeAgentRequest('What is blocking this?', subject)!;
  assert.deepEqual(request.records, [{ type: 'initiative', id: 'p-observability' }, { type: 'work', id: 'wi-obs-e2-b4' }]);
  assert.equal(request.contextLabel, 'Observability Platform › ORG-OBS-11');
  // The context travels as data: the prompt is the question, the scope a typed field.
  assert.equal(request.prompt, 'What is blocking this?');
  assert.deepEqual(request.scope, { kind: 'work', id: 'wi-obs-e2-b4' });
  const other = { ...subject, item: { ...subject.item, id: 'wi-other', key: 'ORG-OBS-13' } };
  initiativeAgentRequest('What next?', other);
  assert.equal(request.records[1].id, 'wi-obs-e2-b4');
});

test('removing context drops both the prose reference and server selection', () => {
  const request = initiativeAgentRequest('/agent Explain the tradeoffs', subject, false)!;
  assert.equal(request.prompt, 'Explain the tradeoffs');
  assert.equal(request.question, 'Explain the tradeoffs');
  assert.equal(request.contextLabel, null);
  assert.deepEqual(request.records, []);
  assert.equal(request.scope, undefined);
});

test('the invoke body carries the scope and the advise-only stance, never in the message', () => {
  const request = initiativeAgentRequest('What is over budget?', subject)!;
  assert.deepEqual(initiativeAgentBody(request.prompt, request, 'sess'), {
    message: 'What is over budget?', sessionId: 'sess',
    scope: { kind: 'work', id: 'wi-obs-e2-b4' }, stance: 'advise',
    selection: { records: [{ type: 'initiative', id: 'p-observability' }, { type: 'work', id: 'wi-obs-e2-b4' }] },
  });
  const bare = initiativeAgentRequest('What is over budget?', subject, false)!;
  assert.deepEqual(initiativeAgentBody(bare.prompt, bare), { message: 'What is over budget?' });
});

test('workflows expand locally and reject commands that do not apply', () => {
  const request = initiativeAgentRequest('/unblock by Friday?', subject)!;
  assert.match(request.prompt, /^What does Eli need/);
  assert.match(request.prompt, /by Friday\?/);
  assert.equal(request.question, '/unblock by Friday?');
  assert.equal(initiativeAgentRequest('/prioritize', subject), null);
  assert.equal(initiativeAgentRequest('  ', subject), null);
});
