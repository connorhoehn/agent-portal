import { test } from 'node:test';
import assert from 'node:assert/strict';

import { canCreateFor, durationLabel, peopleLabel, summaryLine, transcriptSegments, minutesUrl, transcriptUrl, meetingHref, proposalsLive, proposalsUrl,
  goneCopy, meetingsUrl, headerMeta, quietMeta, summaryOf, listLead, listenedLabel, outcomesLabel, orderProposals, proposalClosed, proposalPill,
  actionStatus, actionWaitsOn, createWorkItemUrl, workItemLink, decisionRows, actionText, outcomeShort, facesFor, mergeMeetings, minutesWritten, rewriteUrl, waitingLabel, MINUTES_UNAVAILABLE, type MeetingListRow } from '../meetingsModel.ts';

test('duration reads in minutes and hours', () => {
  assert.equal(durationLabel(0, 20_000), 'under a minute');
  assert.equal(durationLabel(0, 12 * 60_000), '12 min');
  assert.equal(durationLabel(0, 65 * 60_000), '1 h 5 min');
  assert.equal(durationLabel(0, 120 * 60_000), '2 h');
});

test('people read as a sentence and long rosters fold', () => {
  assert.equal(peopleLabel(['Vera']), 'Vera');
  assert.equal(peopleLabel(['Vera', 'Nora']), 'Vera and Nora');
  assert.equal(peopleLabel(['A', 'B', 'C']), 'A, B and C');
  assert.equal(peopleLabel(['A', 'B', 'C', 'D', 'E', 'F']), 'A, B, C and 3 more');
});

test('the summary line is the first sentence, cut when long', () => {
  assert.equal(summaryLine('Vera said: hello there. Nora said: hi.'), 'Vera said: hello there.');
  assert.ok(summaryLine('x'.repeat(300)).length <= 140);
});

test('segments name speakers from the roster and place lines without media offsets by clock time', () => {
  const roster = [{ userId: 'u-1', name: 'Vera Green' }];
  const seg = transcriptSegments([
    { seq: 1, userId: 'u-1', speakerName: 'u-1', text: 'hi', at: 5_000 },
    { seq: 2, userId: null, speakerName: 'Someone', text: 'yo', at: 6_000, startMs: 4000, endMs: 4500 },
  ], roster, 1_000);
  assert.deepEqual(seg[0], { startMs: 4000, endMs: 5000, speakerId: 'u-1', speakerLabel: 'Vera Green', text: 'hi' });
  assert.deepEqual(seg[1], { startMs: 4000, endMs: 4500, speakerLabel: 'Someone', text: 'yo' });
});

test('a work item can be created from an item that is the viewer\'s own or nobody\'s', () => {
  assert.equal(canCreateFor({ text: 'a' }, 'u-1'), true);
  assert.equal(canCreateFor({ text: 'a', ownerUserId: 'u-1' }, 'u-1'), true);
  assert.equal(canCreateFor({ text: 'a', ownerUserId: 'u-2' }, 'u-1'), false);
  assert.equal(canCreateFor({ text: 'a', ownerUserId: 'u-1', done: true }, 'u-1'), false);
});

test('urls are encoded', () => {
  assert.equal(minutesUrl('a/b'), '/api/calls/a%2Fb/assistant/minutes');
  assert.equal(transcriptUrl('c', 5, 100), '/api/calls/c/assistant/transcript?after=5&limit=100');
  assert.equal(meetingHref('c1'), '/iq/meetings/c1');
});

test('the meeting page asks for proposals again only while an answer or a run can change one', () => {
  assert.equal(proposalsUrl('c/1'), '/api/calls/c%2F1/assistant/proposals');
  for (const live of ['open', 'objected', 'consented', 'running']) assert.equal(proposalsLive(['done', live]), true);
  assert.equal(proposalsLive(['done', 'failed', 'dismissed', 'expired']), false);
  assert.equal(proposalsLive([]), false);
});

test('the header: one meta line (when, Nova listened, invited by) and a quieter line for retention, a pause and a count of people not transcribed', () => {
  const at = Date.UTC(2026, 11, 14, 12);
  const meta = headerMeta({ startedAt: at, coverage: { listenedSeconds: 180, pausedSeconds: 0, untranscribed: 0 }, invitedByName: 'Vera Green' });
  assert.equal(meta.listened, 'Nova listened 3 min');
  assert.equal(meta.invitedBy, 'invited by Vera Green');
  assert.equal(headerMeta({ startedAt: at, invitedByName: 'Vera Green' }).listened, null);
  assert.deepEqual(quietMeta({ keptUntil: at, invitedByName: 'Vera Green', youAreInviter: false, coverage: { listenedSeconds: 600, pausedSeconds: 30, untranscribed: 1 } }),
    ['Kept until 14 Dec 2026', 'Vera Green can delete it sooner', '1 person was not transcribed']);
  assert.deepEqual(quietMeta({ keptUntil: at, invitedByName: 'Vera Green', youAreInviter: true, coverage: { listenedSeconds: 600, pausedSeconds: 300, untranscribed: 2 } }),
    ['Kept until 14 Dec 2026', 'You can delete it sooner', 'Nova paused for 5 min', '2 people were not transcribed']);
  assert.deepEqual(quietMeta({ invitedByName: 'Vera Green', youAreInviter: false }), []);
});

test('the summary reads as the server split it, or from the stored lines; an older paragraph is all lead', () => {
  assert.deepEqual(summaryOf({ summary: 'x', summaryLead: 'Lead.', summaryPoints: ['a', 'b', 'c', 'd', 'e'] }), { lead: 'Lead.', points: ['a', 'b', 'c', 'd'] });
  assert.deepEqual(summaryOf({ summary: 'Three people met.\n- Agreed: ship it.\n- Vera to write it up.' }), { lead: 'Three people met.', points: ['Agreed: ship it.', 'Vera to write it up.'] });
  assert.deepEqual(summaryOf({ summary: 'Vera Green said: hello. Nora said: hi.' }), { lead: 'Vera Green said: hello. Nora said: hi.', points: [] });
  assert.equal(listLead({ summary: 'ignored', summaryLead: 'Three people met for 3 minutes about Observability Platform.' }), 'Three people met for 3 minutes about Observability Platform.');
  assert.equal(listLead({ summary: 'Two people met.\n- Agreed: ship.' }), 'Two people met.');
});

test('the list says Nova\'s listening time and the outcomes in a few words', () => {
  assert.equal(listenedLabel(180), '3 min');
  assert.equal(listenedLabel(null), null);
  assert.equal(outcomesLabel({ decisions: 2, actionItems: 3, open: 1 }), '2 decisions · 3 actions · 1 open');
  assert.equal(outcomesLabel({ decisions: 1, actionItems: 0, open: 0 }), '1 decision');
  assert.equal(outcomesLabel({ decisions: 0, actionItems: 0, open: 0 }), 'Nothing recorded');
  assert.equal(outcomesLabel(undefined), null);
});

test('proposals: open ones first, closed ones after; the pill words each state as the call\'s card does', () => {
  const list = [{ id: 'a', state: 'done' }, { id: 'b', state: 'open' }, { id: 'c', state: 'dismissed' }, { id: 'd', state: 'objected' }, { id: 'e', state: 'expired' }];
  assert.deepEqual(orderProposals(list).map((p) => p.id), ['b', 'd', 'a', 'c', 'e']);
  assert.equal(proposalClosed('failed'), true); assert.equal(proposalClosed('consented'), false);
  assert.deepEqual(proposalPill({ state: 'open' }), { label: 'Waiting for consent', tone: 'pending' });
  assert.equal(proposalPill({ state: 'dismissed', source: 'watcher', outcome: { kind: 'decision' }, run: null }).label, 'Not a decision');
  assert.equal(proposalPill({ state: 'dismissed', source: 'asked', outcome: { kind: 'tool' }, run: null }).label, 'Dropped');
  assert.equal(proposalPill({ state: 'dismissed', source: 'watcher', outcome: { kind: 'decision' }, run: { raisedAs: 'p2' } }).label, 'Raised again');
});

test('action items: their status, and which wait on the viewer', () => {
  assert.equal(actionStatus({ text: 'a', done: true }).label, 'Done in the call');
  assert.equal(actionStatus({ text: 'a', workItemCreated: true }).label, 'Work item created');
  assert.equal(actionStatus({ text: 'a' }).label, 'Not created');
  assert.equal(actionWaitsOn({ text: 'a', ownerUserId: 'u-vera' }, 'u-vera'), true);
  assert.equal(actionWaitsOn({ text: 'a', ownerUserId: 'u-vera', workItemCreated: true }, 'u-vera'), false);
  assert.equal(actionWaitsOn({ text: 'a' }, 'u-vera'), false, 'nobody\'s item does not wait on anyone');
  assert.equal(actionWaitsOn({ text: 'a', ownerUserId: 'u-nora' }, 'u-vera'), false);
});

test('decisions: those agreed through proposals (with who consented and the link once recorded), then the minutes\' own lines', () => {
  const rows = decisionRows({ decisions: ['Ship Thursday'], initiativeId: 'p1' }, [
    { id: 'x', statement: 'Freeze schema', state: 'done', outcome: { kind: 'decision', initiativeId: 'p2' }, responses: [{ name: 'Vera', response: 'consent' }, { name: 'Theo', response: 'object' }], run: { href: '/iq/decisions/d1' } },
    { id: 'y', statement: 'Open one', state: 'open', outcome: { kind: 'decision' }, responses: [], run: null },
    { id: 'z', statement: 'A work item', state: 'done', outcome: { kind: 'tool' }, responses: [], run: { href: '/x' } },
  ]);
  assert.deepEqual(rows, [
    { key: 'px', text: 'Freeze schema', initiativeId: 'p2', agreedBy: ['Vera'], href: '/iq/decisions/d1' },
    { key: 'm0', text: 'Ship Thursday', initiativeId: 'p1', agreedBy: [], href: null },
  ]);
});

test('a gone meeting is explained only to the people the server told; everyone else reads the neutral sentence', () => {
  assert.equal(goneCopy({ status: 410, code: 'MEETING_DELETED' }).description, 'This meeting\'s record was deleted.');
  assert.equal(goneCopy({ status: 410, code: 'MEETING_EXPIRED' }).description, 'This meeting\'s record was removed after the retention period.');
  assert.equal(goneCopy({ status: 404, code: null }).description, 'There is no meeting record here. It may have been deleted, removed after the retention period, or you were not in that call.');
  assert.equal(goneCopy({ status: 404, code: 'MINUTES_WRITING' }).writing, true);
});

test('unwritten minutes never read as "nothing was decided"', () => {
  assert.equal(minutesWritten({ writer: 'none' }), false);
  assert.equal(minutesWritten({ writer: 'scripted' }), true);
  assert.equal(MINUTES_UNAVAILABLE, 'Not available because the minutes could not be written.');
});

test('the list pages by the server cursor and merges pages once each; the waiting pill counts only when something waits', () => {
  assert.equal(meetingsUrl(), '/api/meetings?limit=50');
  assert.equal(meetingsUrl(1234), '/api/meetings?limit=50&before=1234');
  assert.equal(rewriteUrl('c 1'), '/api/calls/c%201/assistant/minutes/rewrite');
  const row = (callId: string) => ({ callId }) as MeetingListRow;
  assert.deepEqual(mergeMeetings([row('a'), row('b')], [row('b'), row('c')]).map((r) => r.callId), ['a', 'b', 'c']);
  assert.equal(waitingLabel(0), null);
  assert.equal(waitingLabel(undefined), null);
  assert.equal(waitingLabel(2), '2 waiting on you');
});

test('done-action text never reaches a person as "Ran create" or "Created work item: X"', () => {
  assert.equal(actionText('Created work item: the login cookie bug'), 'Created work item "the login cookie bug"');
  assert.equal(actionText('Ran create'), 'Created a record');
  assert.equal(actionText('Ran something_else'), 'Nova carried out a request');
  assert.equal(actionText('review the schema'), 'review the schema');
});

test('what a proposal does, short: the kind and the target', () => {
  assert.equal(outcomeShort({ kind: 'decision' }, 'Observability Platform'), 'Decision · Observability Platform');
  assert.equal(outcomeShort({ kind: 'tool', name: 'create', summary: 'Create a work item titled "X", owned by Nora' }, 'Observability Platform'), 'Work item · Observability Platform');
  assert.equal(outcomeShort({ kind: 'tool', name: 'update' }, null), 'Update');
});

test('faces carry the portrait the server sent, by name; others draw initials', () => {
  assert.deepEqual(facesFor(['Vera Green', 'Theo Chang'], [{ name: 'Vera Green', avatarUrl: '/avatars/photos/v.jpg' }, { name: 'Theo Chang', avatarUrl: null }]),
    [{ name: 'Vera Green', src: '/avatars/photos/v.jpg' }, { name: 'Theo Chang' }]);
});

test('an action item made into a work item from the meeting page reads created, with the server\'s link and nothing else', () => {
  const made = { text: 'update the runbook', workItemCreated: true, workItemHref: '/iq/projects/p-auth?tab=work&item=wi-1' };
  assert.equal(actionStatus(made).label, 'Work item created');
  assert.equal(workItemLink(made), '/iq/projects/p-auth?tab=work&item=wi-1');
  assert.equal(actionWaitsOn({ ...made, ownerUserId: 'u-a' }, 'u-a'), false);
  for (const href of ['https://evil.example/iq/projects/p?tab=work&item=x', '//evil.example', '/iq/projects/p?tab=work&item=x&next=/', 'javascript:alert(1)', null, undefined]) {
    assert.equal(workItemLink({ text: 'a', workItemCreated: true, workItemHref: href as string | null }), null, String(href));
  }
  assert.equal(actionStatus({ text: 'a' }).label, 'Not created');
  assert.equal(createWorkItemUrl('call 1', 2), '/api/calls/call%201/assistant/minutes/action-items/2/work-item');
});
