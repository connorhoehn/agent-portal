import assert from 'node:assert/strict';
import { test } from 'node:test';
import { acceptedCallHref, callPeopleHref, callScopeKey, hasJoinedCall, huddleChatScopeTenant, pageHuddleHref, shellCallDockTestId } from '../callShellModel.ts';

const actor = { sub: 'u-vera', tenant: 'orgiq', masquerading: null };
test('Accept retains work, scoped Search, and a deck already bound to the same initiative', () => {
  assert.equal(acceptedCallHref('initiative:p-observability', '/iq/projects/p-observability?tab=work&item=wi-obs-e2-b4', null), null);
  assert.equal(acceptedCallHref('orgiq:initiative:p-observability', '/iq/search?scope=p-observability&q=dependency', null), null);
  assert.equal(acceptedCallHref('initiative:p-observability', '/iq/decks/deck-one', 'orgiq:initiative:p-observability'), null);
  assert.equal(acceptedCallHref('orgiq:initiative:p-observability', '/iq/decks/deck-one', 'initiative:p-observability'), null);
  assert.equal(acceptedCallHref('orgiq:initiative:p-other', '/iq/decks/deck-one', 'initiative:p-observability'), '/iq/projects/p-other');
});

test('a solo page huddle is joined even before an invite acceptance gives it a start timestamp', () => {
  const solo = { callId: 'call-demo', startedAt: null };
  // `connecting` counts: the seat admits the chat before media is up (and media never is on the signalling-only fixture).
  for (const phase of ['connecting', 'live', 'reconnecting']) assert.equal(hasJoinedCall(solo, phase), true);
  for (const phase of ['idle', 'calling', 'ringing', 'ended', 'failed']) assert.equal(hasJoinedCall(solo, phase), false);
  assert.equal(hasJoinedCall(null, 'live'), false);
});

test('same actor refresh retains call scope; identity, tenant and masquerade authority replace it', () => {
  assert.equal(callScopeKey({ ...actor }), callScopeKey(actor));
  assert.notEqual(callScopeKey({ ...actor, sub: 'u-nora' }), callScopeKey(actor));
  assert.notEqual(callScopeKey({ ...actor, tenant: 'social' }), callScopeKey(actor));
  const mask = { ...actor, masquerading: { actor: 'u-admin', asUser: 'u-vera' } };
  assert.notEqual(callScopeKey(mask), callScopeKey(actor));
  assert.notEqual(callScopeKey({ ...mask, masquerading: { actor: 'u-other-admin', asUser: 'u-vera' } }), callScopeKey(mask));
  assert.notEqual(callScopeKey(null), callScopeKey(actor));
});

test('People navigation resolves canonical routes after the call page unmounts', () => {
  assert.equal(callPeopleHref('initiative:p-auth', 'orgiq'), '/iq/projects/p-auth?tab=contributors');
  assert.equal(callPeopleHref('search:p-004', 'orgiq'), '/iq/search?tab=connections&selection=person%3Ap-004');
  assert.equal(callPeopleHref('social:room:design', 'social'), '/social/contacts');
  assert.equal(callPeopleHref('assessment-document:/assessment/workspace?doc=page%3A123', 'assessment'), '/assessment/workspace?doc=page%3A123');
  assert.equal(callPeopleHref('assessment-document:https://external.invalid/', 'assessment'), null);
});

test('the single shell dock retains existing automation names by call scope', () => {
  assert.equal(shellCallDockTestId('initiative:p-auth', 'orgiq'), 'initiative-call-dock');
  assert.equal(shellCallDockTestId('search:p-004', 'orgiq'), 'search-call-dock');
  assert.equal(shellCallDockTestId('assessment-document:/assessment/workspace?doc=page%3A123', 'assessment'), 'document-call-dock');
  assert.equal(shellCallDockTestId('social:dm:u-a:u-b', 'social'), 'social-call-dock');
});

test('a page huddle lobby names its page for the dock (canonical shapes only)', async () => {
  const { pageHuddleHref } = await import('../callShellModel.ts');
  assert.equal(pageHuddleHref('assessment:team:TEAM-005'), '/assessment/teams/TEAM-005');
  assert.equal(pageHuddleHref('pipelines:run:run-42'), '/pipelines/runs/run-42');
  assert.equal(callPeopleHref('assessment:team:TEAM-005', 'assessment'), '/assessment/teams/TEAM-005');
  assert.equal(shellCallDockTestId('pipelines:run:run-42', 'pipelines'), 'page-call-dock');
  for (const bad of ['assessment:team:../x', 'assessment:team:team-1', 'pipelines:run:a/b', 'pipelines:run:', 'orgiq:initiative:p-1', null]) {
    assert.equal(pageHuddleHref(bad), null, String(bad));
  }
});

test('every joined call asks the server for its huddle conversation under the session tenant; the lobby rule is not copied here', () => {
  // Which lobbies admit a conversation is decided by GET /api/calls/:id/chat (lib/call-access.ts huddleLobbyTenant);
  // a refusal reads as `denied` in HuddleRoster. The client only scopes the ask to a joined call.
  assert.equal(huddleChatScopeTenant('orgiq', true), 'orgiq');
  assert.equal(huddleChatScopeTenant('assessment', true), 'assessment');
  assert.equal(huddleChatScopeTenant('pipelines', true), 'pipelines');
  assert.equal(huddleChatScopeTenant('social', true), 'social');
  assert.equal(huddleChatScopeTenant('orgiq', false), null);
  assert.equal(huddleChatScopeTenant(null, true), null);
});
