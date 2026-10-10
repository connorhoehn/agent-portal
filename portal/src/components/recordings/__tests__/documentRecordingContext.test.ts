import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentRecordingNavigation, documentRecordingHref } from '../documentRecordingContext.ts';
import { conversationChannelForDoc } from '../../../pages/assessment/knowledge/knowledgeFormat.ts';
import { documentCallLobby } from '../../../pages/assessment/knowledge/documentCommentsModel.ts';
const sourceId = 'ec:long/source/identity/with/spaces here';
const lobby = documentCallLobby('assessment:', conversationChannelForDoc(sourceId));
test('hashed document lobbies retain their exact explicit source ID and original route family', () => {
  assert.match(lobby, /^assessment:doc:h:/);
  for (const family of ['workspace', 'enterprise', 'rules', 'prompts']) {
    const navigation = documentRecordingNavigation(lobby, `assessment-document:/assessment/${family}?doc=${encodeURIComponent(sourceId)}`)!;
    assert.equal(navigation.documentSourceId, sourceId);
    const href = documentRecordingHref(lobby, navigation, 'exact recording')!;
    const url = new URL(href, 'https://local.invalid');
    assert.equal(url.pathname, `/assessment/${family}`);
    assert.equal(url.searchParams.get('doc'), sourceId);
    assert.equal(url.searchParams.get('recording'), 'exact recording');
    assert.equal(url.searchParams.get('tab'), 'recordings');
  }
});
test('forged URLs, mismatched source IDs and ambiguous or oversized navigation are refused', () => {
  for (const channel of [
    `assessment-document:https://outside.invalid/assessment/workspace?doc=${encodeURIComponent(sourceId)}`,
    'assessment-document:/iq/workspace?doc=page:100002',
    'assessment-document:/assessment/communication?doc=page:100002',
    'assessment-document:/assessment/workspace?doc=page:other',
    `assessment-document:/assessment/workspace?doc=${encodeURIComponent(sourceId)}&doc=page:other`,
    `assessment-document:/assessment/workspace?doc=${encodeURIComponent(sourceId)}&redirect=outside`,
    `assessment-document:/assessment/workspace?doc=${encodeURIComponent(sourceId)}#different-source`,
    'assessment-document:/assessment/workspace?doc=%00',
    'assessment-document:/assessment/workspace?doc=%7F',
    `assessment-document:/assessment/workspace?doc=${'x'.repeat(1025)}`,
  ]) assert.equal(documentRecordingNavigation(lobby, channel), null);
  assert.equal(documentRecordingNavigation('orgiq:doc:page:100002', 'assessment-document:/assessment/workspace?doc=page:100002'), null);
  assert.equal(documentRecordingHref(lobby, { documentSourceId: 'different', href: `/assessment/workspace?doc=${encodeURIComponent(sourceId)}` }), null);
});
