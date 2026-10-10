import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initiativeAgentRequest } from '../initiativeAgentRequest.ts';
import { briefFacts } from '../../project-detail/briefModel.ts';
import { workRows } from '../../project-detail/workListModel.ts';
import { OBS_PROJECT, OBS_TREE } from '../../project-detail/__tests__/obsFixture.ts';

const item = workRows(OBS_TREE, 'priority', '').find(row => row.id === 'wi-obs-e2-b4')!;
const subject = { kind: 'item' as const, project: { ...OBS_PROJECT }, item: { ...item, key: 'ORG-OBS-11' }, facts: briefFacts(item, { data: [] }) };

test('a run carries only typed IDs and snapshots the originating work context', () => {
  const request = initiativeAgentRequest('What is blocking this?', subject)!;
  assert.deepEqual(request.records, [{ type: 'initiative', id: 'p-observability' }, { type: 'work', id: 'wi-obs-e2-b4' }]);
  assert.equal(request.contextLabel, 'Observability Platform › ORG-OBS-11');
  assert.match(request.prompt, /Advise only; do not change anything/);
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
});

test('workflows expand locally and reject commands that do not apply', () => {
  const request = initiativeAgentRequest('/unblock by Friday?', subject)!;
  assert.match(request.prompt, /^What does Eli need/);
  assert.match(request.prompt, /by Friday\?/);
  assert.equal(request.question, '/unblock by Friday?');
  assert.equal(initiativeAgentRequest('/prioritize', subject), null);
  assert.equal(initiativeAgentRequest('  ', subject), null);
});
