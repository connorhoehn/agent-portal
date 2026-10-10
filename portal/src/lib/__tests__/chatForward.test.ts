import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForwardSource, composeForwardBody, forwardMetadata, forwardTargets, forwardedFromRef, originLabel, readForwardedFrom, scopedChannel, scopedOriginLabel, MAX_FORWARD_LENGTH } from '../chatForward.ts';

const origin = { channel: 'social:ch:general', label: '#general' };
const message = { id: 'm1', userId: 'u-mira', displayName: 'Mira', content: ' hello team ', timestamp: '2026-10-07T10:00:00Z',
  metadata: { pageReference: { kind: 'work-item', id: 'wi-1' }, attachments: [{ id: 'a', name: 'plan.pdf' }] } };

test('the source keeps author, time, words and the page reference (kind/id only)', () => {
  const source = buildForwardSource(message, origin)!;
  assert.equal(source.author, 'Mira'); assert.equal(source.text, 'hello team');
  assert.deepEqual(source.page, { kind: 'work-item', id: 'wi-1' });
  assert.deepEqual(source.attachmentNames, ['plan.pdf']);
  assert.equal(buildForwardSource({ ...message, id: undefined }, origin), null);
  assert.equal(buildForwardSource({ ...message, content: '  ', metadata: {} }, origin), null);
});

test('a forged page reference is dropped, not forwarded', () => {
  const source = buildForwardSource({ ...message, metadata: { pageReference: { kind: 'work-item', id: 'x', title: 'Secret' } } }, origin)!;
  assert.equal(source.page, null);
});

test('the body is the header, the words, and names (not bytes) of files; the header survives truncation', () => {
  const source = buildForwardSource(message, origin)!;
  assert.equal(composeForwardBody(source, 'Forwarded from #general — Mira:'), 'Forwarded from #general — Mira:\nhello team\n[Not forwarded: plan.pdf]');
  const long = buildForwardSource({ ...message, content: 'x'.repeat(5000), metadata: {} }, origin)!;
  const body = composeForwardBody(long, 'Forwarded from #general — Mira:');
  assert.ok(body.length <= MAX_FORWARD_LENGTH && body.startsWith('Forwarded from #general — Mira:\n') && body.endsWith('…'));
});

test('metadata carries forwardedFrom; the page reference rides only to a DM', () => {
  const source = buildForwardSource(message, origin)!;
  const dm = forwardMetadata(source, 'social:dm:a:b', 'Lena', 'd1');
  assert.deepEqual(dm.pageReference, { kind: 'work-item', id: 'wi-1' });
  assert.deepEqual(readForwardedFrom(dm.forwardedFrom), forwardedFromRef(source));
  assert.equal(forwardMetadata(source, 'social:ch:other', 'Lena', 'd2').pageReference, undefined);
  assert.equal(dm.displayName, 'Lena');
});

test('a private origin is not named to the recipient', () => {
  assert.equal(originLabel('social:ch:x', 'x', true), '#x');
  assert.equal(originLabel('social:ch:x', 'x', false), 'a private conversation');
  assert.equal(originLabel('social:dm:a:b', null, false), 'a direct message');
});

test('targets: only conversations the actor can post to, never the origin or a channel they have not joined', () => {
  const input = { originChannel: 'social:ch:general', dms: [{ channel: 'social:dm:a:b' }],
    channels: [{ channel: 'social:ch:general', joined: true }, { channel: 'social:ch:ops', joined: true }, { channel: 'social:ch:secret', joined: false }],
    canSendDms: true, canPostChannels: true };
  assert.deepEqual(forwardTargets(input).map(t => t.channel), ['social:dm:a:b', 'social:ch:ops']);
  assert.deepEqual(forwardTargets({ ...input, canPostChannels: false }).map(t => t.channel), ['social:dm:a:b']);
  assert.deepEqual(forwardTargets({ ...input, canSendDms: false, canPostChannels: false }), []);
});

const base = { originChannel: 'x', dms: [{ channel: 'social:dm:a:b' }], canSendDms: true, channels: [], canPostChannels: false };
const scoped = { teams: [{ id: 'TEAM-001', label: 'A' }, { id: 'TEAM-005', label: 'B' }], initiatives: [{ id: 'p-auth', label: 'Auth' }], runs: [{ id: 'r1', label: 'Run r1' }] };

test('scoped targets are offered only in their own tenant and only when posting is allowed', () => {
  const ch = (t: ReturnType<typeof forwardTargets>) => t.map(x => x.channel);
  assert.deepEqual(ch(forwardTargets({ ...base, tenant: 'assessment', scoped, canPostScoped: true })), ['social:dm:a:b', 'assessment:team:TEAM-001', 'assessment:team:TEAM-005']);
  assert.deepEqual(ch(forwardTargets({ ...base, tenant: 'orgiq', scoped, canPostScoped: true })), ['social:dm:a:b', 'orgiq:initiative:p-auth']);
  assert.deepEqual(ch(forwardTargets({ ...base, tenant: 'pipelines', scoped, canPostScoped: true })), ['social:dm:a:b', 'pipelines:run:r1']);
  assert.deepEqual(ch(forwardTargets({ ...base, tenant: 'social', scoped, canPostScoped: true })), ['social:dm:a:b']);
  assert.deepEqual(ch(forwardTargets({ ...base, tenant: 'assessment', scoped, canPostScoped: false })), ['social:dm:a:b']);
});

test('the origin is never a target and a team outside the list is absent', () => {
  const t = forwardTargets({ ...base, originChannel: 'assessment:team:TEAM-001', tenant: 'assessment', scoped, canPostScoped: true });
  assert.deepEqual(t.map(x => x.channel), ['social:dm:a:b', 'assessment:team:TEAM-005']);
  assert.ok(!t.some(x => x.channel === scopedChannel.team('TEAM-009')));
});

test('a scoped origin is named by its page name', () => {
  assert.equal(scopedOriginLabel('assessment:team:TEAM-001', scoped), 'A');
  assert.equal(scopedOriginLabel('assessment:team:TEAM-009', scoped), null);
});

test('work-item threads are listed under their initiative, only for orgiq posters, never closed items', () => {
  const base = { originChannel: 'orgiq:initiative:p-a', dms: [], canSendDms: false, channels: [], canPostChannels: false, tenant: 'orgiq', canPostScoped: true,
    scoped: { initiatives: [{ id: 'p-a', label: 'Auth' }], workItems: [
      { id: 'wi-1', label: 'Fix login', initiativeId: 'p-a', initiativeName: 'Auth', status: 'open' },
      { id: 'wi-2', label: 'Old', initiativeId: 'p-a', initiativeName: 'Auth', status: 'done' }] } };
  const t = forwardTargets(base);
  assert.deepEqual(t.map(x => x.channel), ['orgiq:work:wi-1']);
  assert.equal(t[0]!.section, 'Work in Auth');
  assert.deepEqual(forwardTargets({ ...base, canPostScoped: false }), []);
  assert.deepEqual(forwardTargets({ ...base, tenant: 'assessment' }), []);
  assert.deepEqual(forwardTargets({ ...base, originChannel: 'orgiq:work:wi-1' }).map(x => x.channel), ['orgiq:initiative:p-a']);
  assert.equal(scopedOriginLabel('orgiq:work:wi-1', base.scoped), 'Fix login');
});
