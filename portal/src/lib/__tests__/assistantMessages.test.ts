import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actionCardView, askedByLine, decideAssistantAction, readAssistantMessage, type AssistantAction } from '../assistantMessages.ts';

const card = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  assistant: true, displayName: 'Milo', kind: 'assistant-action', actionId: 'act-1', askedBy: 'u-vera', askedByName: 'Vera Lindqvist',
  summary: 'Create work item "Login cookie bug"', detail: ['Assignee: Priya'], tool: { name: 'create_work_item', argsDigest: 'sha256:ab' }, status: 'waiting', ...over,
});

test('reads the three kinds and nothing else', () => {
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice' }), { kind: 'assistant-notice' });
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-reply', askedBy: 'u-vera', askedByName: 'Vera' }), { kind: 'assistant-reply', askedBy: 'u-vera', askedByName: 'Vera' });
  const action = readAssistantMessage(card());
  assert.equal(action?.kind, 'assistant-action');
  assert.equal(readAssistantMessage(undefined), null);
  assert.equal(readAssistantMessage({ kind: 'assistant-notice' }), null, 'no marker, no Milo');
  assert.equal(readAssistantMessage({ kind: 'call', callId: 'x' }), null);
});

test('a malformed card or reply is not a card', () => {
  assert.equal(readAssistantMessage({ assistant: true, kind: 'assistant-reply', askedBy: 'u' }), null);
  assert.equal(readAssistantMessage(card({ status: 'pending' })), null);
  assert.equal(readAssistantMessage(card({ tool: undefined })), null);
  assert.equal(readAssistantMessage(card({ actionId: '' })), null);
  assert.deepEqual((readAssistantMessage(card({ detail: undefined })) as AssistantAction).detail, []);
});

test('a reply is captioned with who asked', () => {
  assert.equal(askedByLine({ askedByName: 'Vera Lindqvist' }), 'Asked by Vera Lindqvist');
});

test('only the asker gets Confirm and Decline, and only while it waits; everyone else reads "Waiting for <name>"', () => {
  const waiting = readAssistantMessage(card()) as AssistantAction;
  assert.deepEqual(actionCardView(waiting, 'u-vera'), { statusLabel: 'Waiting for confirmation', tone: 'pending', canDecide: true, waitingNote: null });
  const other = actionCardView(waiting, 'u-release');
  assert.equal(other.canDecide, false);
  assert.equal(other.waitingNote, 'Waiting for Vera Lindqvist');
  assert.equal(actionCardView(waiting, null).canDecide, false);
});

test('a decided card has no controls and no waiting note for anyone', () => {
  for (const status of ['confirmed', 'declined', 'expired', 'done', 'failed']) {
    const action = readAssistantMessage(card({ status })) as AssistantAction;
    for (const viewer of ['u-vera', 'u-release']) {
      const view = actionCardView(action, viewer);
      assert.equal(view.canDecide, false, `${status} for ${viewer}`);
      assert.equal(view.waitingNote, null);
    }
  }
  assert.equal(actionCardView(readAssistantMessage(card({ status: 'done' })) as AssistantAction, 'u-vera').tone, 'success');
  assert.equal(actionCardView(readAssistantMessage(card({ status: 'failed' })) as AssistantAction, 'u-vera').tone, 'error');
});

test('the decision posts to the call\'s route and names the refusal when it is refused', async () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const ok = (async (url: string, init: RequestInit) => { seen.push({ url, init }); return new Response('{}', { status: 200 }); }) as unknown as typeof fetch;
  await decideAssistantAction('call 1', 'act-1', 'confirm', ok);
  assert.equal(seen[0]!.url, '/api/calls/call%201/assistant/actions/act-1/decision');
  assert.equal(seen[0]!.init.method, 'POST');
  assert.equal(seen[0]!.init.credentials, 'include');
  assert.deepEqual(JSON.parse(String(seen[0]!.init.body)), { decision: 'confirm' });
  const no = (async () => new Response(JSON.stringify({ error: 'Only the person who asked can decide this action' }), { status: 403 })) as unknown as typeof fetch;
  await assert.rejects(decideAssistantAction('call-1', 'act-1', 'decline', no), /Only the person who asked/);
  const bare = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
  await assert.rejects(decideAssistantAction('call-1', 'act-1', 'decline', bare), /could not be saved \(500\)/);
});

test('S16: a closing notice carries its meeting in metadata, and only a well-formed id', async () => {
  const { readAssistantMessage } = await import('../assistantMessages.ts');
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice', meetingCallId: 'c-1' }), { kind: 'assistant-notice', meetingCallId: 'c-1' });
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice' }), { kind: 'assistant-notice' });
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice', meetingCallId: 7 }), { kind: 'assistant-notice' });
});

test('the card names the call initiative only for a new work item that names none', async () => {
  const { namesNoInitiative } = await import('../assistantMessages.ts');
  const tool = { name: 'create', argsDigest: '' };
  assert.equal(namesNoInitiative({ tool, detail: ['kind: work-item', 'title: Fix it'] }), true);
  assert.equal(namesNoInitiative({ tool, detail: ['kind: work-item', 'title: Fix it', 'initiative: Atlas'] }), false);
  assert.equal(namesNoInitiative({ tool, detail: ['kind: initiative', 'name: Atlas'] }), false);
  assert.equal(namesNoInitiative({ tool: { name: 'update', argsDigest: '' }, detail: ['kind: work-item'] }), false);
});

test('a minutes notice carries well-formed counts only, and every Milo message is told apart from a person\'s', async () => {
  const { readAssistantMessage, isAssistantChatMessage, minutesCountLabels } = await import('../assistantMessages.ts');
  const minutes = { decisions: 2, actionItems: 1, proposals: 0 };
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice', meetingCallId: 'c-1', minutes }), { kind: 'assistant-notice', meetingCallId: 'c-1', minutes });
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice', minutes: { decisions: -1, actionItems: 1, proposals: 0 } }), { kind: 'assistant-notice' });
  assert.deepEqual(readAssistantMessage({ assistant: true, kind: 'assistant-notice', minutes: { decisions: 1.5, actionItems: 1 } }), { kind: 'assistant-notice' });
  assert.deepEqual(minutesCountLabels(minutes), { decisions: '2 decisions', actionItems: '1 action item', proposals: '0 proposals' });
  assert.equal(isAssistantChatMessage({ metadata: { assistant: true, kind: 'assistant-reply', askedBy: 'u-1', askedByName: 'Vera' } }), true);
  assert.equal(isAssistantChatMessage({ metadata: { assistant: true, kind: 'assistant-notice' } }), true);
  assert.equal(isAssistantChatMessage({ metadata: { kind: 'assistant-reply' } }), false);
  assert.equal(isAssistantChatMessage({}), false);
});

test('the action card\'s anatomy: a headline, one plain-words line, who it waits on, and no key: value rows', async () => {
  const { actionDoesLine, actionHeader, actionNeedsLine, actionTitle } = await import('../assistantMessages.ts');
  const a = readAssistantMessage(card({ tool: { name: 'create', argsDigest: '' }, detail: ['title: the login cookie bug', 'kind: work-item'], title: 'the login cookie bug', does: 'Creates a work item' })) as AssistantAction;
  assert.equal(a.title, 'the login cookie bug');
  assert.equal(actionHeader(a), 'Action · asked by Vera Lindqvist');
  assert.equal(actionTitle(a), 'the login cookie bug');
  assert.equal(actionDoesLine(a, 'Observability Platform'), 'Creates a work item in Observability Platform');
  assert.equal(actionDoesLine(a, null), 'Creates a work item');
  for (const line of [actionHeader(a), actionTitle(a), actionDoesLine(a, 'Observability Platform')!]) assert.doesNotMatch(line, /\w+: \w/);
  // an older card with no title or line: the sentence is the headline, and nothing is invented
  const old = readAssistantMessage(card()) as AssistantAction;
  assert.equal(actionTitle(old), old.summary);
  assert.equal(actionDoesLine(old, 'Observability Platform'), null);
  assert.equal(actionNeedsLine(a, 'u-vera'), 'Waiting for you to confirm');
  assert.equal(actionNeedsLine(a, 'u-nora'), 'Waiting for Vera Lindqvist');
  assert.equal(actionNeedsLine({ ...a, status: 'done' }, 'u-nora'), null);
});

test('state decides the card\'s size: waiting on you, on others, done as a row, closed as a muted row with its reason', async () => {
  const { actionLayout, actionRowText } = await import('../assistantMessages.ts');
  const a = readAssistantMessage(card({ tool: { name: 'create', argsDigest: '' }, title: 'the login cookie bug' })) as AssistantAction;
  assert.equal(actionLayout(a, 'u-vera'), 'you');
  assert.equal(actionLayout(a, 'u-nora'), 'others');
  assert.equal(actionLayout(a, null), 'others');
  assert.equal(actionLayout({ ...a, status: 'confirmed' }, 'u-vera'), 'others');
  assert.equal(actionLayout({ ...a, status: 'done' }, 'u-vera'), 'done');
  for (const status of ['declined', 'expired', 'failed'] as const) assert.equal(actionLayout({ ...a, status }, 'u-vera'), 'muted');
  assert.equal(actionRowText({ ...a, status: 'done', resultText: 'Created WI-12.' }), 'Created “the login cookie bug”');
  assert.equal(actionRowText({ ...a, status: 'expired', resultText: 'Milo was dismissed before this was done.' }), 'the login cookie bug · Milo was dismissed before this was done.');
  assert.equal(actionRowText({ ...a, status: 'declined' }), 'the login cookie bug · Vera Lindqvist declined it, so nothing was done.');
  const update = { ...a, title: undefined, tool: { name: 'update', argsDigest: '' }, summary: 'Update the work item' } as AssistantAction;
  assert.match(actionRowText({ ...update, status: 'failed', resultText: 'Use the full name.' }), /^Update the work item · Use the full name\.$/);
});

test('the minutes counts read as one line; a long notice splits at its first sentence, a short one stays a pill', async () => {
  const { isLongNotice, minutesCountLine, splitNotice } = await import('../assistantMessages.ts');
  assert.equal(minutesCountLine({ decisions: 2, actionItems: 1, proposals: 0 }), '2 decisions · 1 action item · 0 proposals');
  // An addition's card counts what it added.
  assert.equal(minutesCountLine({ decisions: 0, actionItems: 1, proposals: 1, added: true }), '0 new decisions · 1 new action item · 1 new proposal');
  const join = "Milo joined at Vera Green's invitation. Once you acknowledge, what you say is sent to the speech provider and kept as text for 30 days. Milo writes minutes.";
  assert.equal(isLongNotice(join), true);
  assert.deepEqual(splitNotice(join), { first: "Milo joined at Vera Green's invitation.", rest: 'Once you acknowledge, what you say is sent to the speech provider and kept as text for 30 days. Milo writes minutes.' });
  assert.equal(isLongNotice('Nora DaSilva paused Milo. Nothing is being heard or stored.'), false);
  assert.deepEqual(splitNotice('One sentence only'), { first: 'One sentence only', rest: '' });
});

test('a minutes notice that adds to earlier minutes says so; anything else is not an addition', () => {
  const added = readAssistantMessage({ assistant: true, kind: 'assistant-notice', meetingCallId: 'c1', minutes: { decisions: 1, actionItems: 2, proposals: 0, added: true } });
  assert.deepEqual(added, { kind: 'assistant-notice', meetingCallId: 'c1', minutes: { decisions: 1, actionItems: 2, proposals: 0, added: true } });
  const first = readAssistantMessage({ assistant: true, kind: 'assistant-notice', minutes: { decisions: 1, actionItems: 2, proposals: 0, added: 'yes' } });
  assert.deepEqual(first, { kind: 'assistant-notice', minutes: { decisions: 1, actionItems: 2, proposals: 0 } });
});
