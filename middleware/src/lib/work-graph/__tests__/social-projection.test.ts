// The social projection (social-projection.ts), pure: default deny, day membership, the documented edges only,
// and that nothing but a count and the people who posted is carried for a thread.
import { workDayWindow } from '@connorhoehnslalom/realtime-modules/work-graph';
import { callStatus, projectSocialWorkGraph, recordingStatus, sNodeIdFor, type SocialProjectionInput } from '../social-projection.js';
import { socialPolicyRevisionFor } from '../snapshot.js';

const w = workDayWindow('2026-10-06', 'UTC');
const AT = '2026-10-06T12:00:00.000Z';
const GENERAL = 'social:ch:general';
const DM = 'social:dm:u-lena:u-sana';
const TEAMCH = 'social:team:community:general';
const base = (over: Partial<SocialProjectionInput> = {}): SocialProjectionInput => ({
  window: w, observedAt: AT, scope: 'workspace',
  conversations: [
    { id: GENERAL, kind: 'channel', title: '#general', private: false, teamId: null, updatedAt: '2026-10-01T09:00:00.000Z', people: [] },
    { id: DM, kind: 'dm', title: 'Lena Brandt', private: true, teamId: null, updatedAt: '2026-10-05T09:00:00.000Z', people: [{ id: 'u-lena', name: 'Lena Brandt' }] },
    { id: TEAMCH, kind: 'team-channel', title: 'Community / General', private: false, teamId: 'team-c', updatedAt: '2026-10-02T09:00:00.000Z', people: [] },
  ],
  teams: [{ id: 'team-c', name: 'Community', updatedAt: '2026-10-02T09:00:00.000Z', role: 'member' }],
  threads: [{ conversationId: GENERAL, count: 3, firstAt: '2026-10-06T09:00:00.000Z', lastAt: '2026-10-06T10:00:00.000Z', people: [{ id: 'u-mira', name: 'Mira' }, { id: 'u-theo', name: 'Theo' }] }],
  calls: [], recordings: [], decks: [], flowRuns: [],
  reads: { view: true, post: true, call: true },
  ...over,
});
const ids = (p: { nodes: Array<{ id: string }> }) => p.nodes.map(n => n.id).sort();

it('draws nothing without ViewSocial, whatever else is true', () => {
  const out = projectSocialWorkGraph(base({ reads: { view: false, post: true, call: true } }));
  expect(out.nodes).toEqual([]); expect(out.edges).toEqual([]); expect(out.details).toEqual([]);
});

it('the workspace draws only conversations with something in the day: a quiet DM and team channel are absent', () => {
  const out = projectSocialWorkGraph(base());
  expect(ids(out)).toEqual([`sconv:${GENERAL}`, `sthread:${GENERAL}`]);
  expect(out.edges.map(e => e.relation)).toEqual(['discussed']);
  const thread = out.details.find(d => d.nodeId === `sthread:${GENERAL}`)!;
  expect(thread.lines).toEqual(['Messages · 3', 'People · 2']);
  expect(JSON.stringify(out)).not.toMatch(/text|message body/i);
});

it('calls, recordings, decks and runs hang off their conversation; a recording points at its call when drawn, else at the conversation', () => {
  const out = projectSocialWorkGraph(base({
    calls: [{ id: 'c1', conversationId: DM, direction: 'outgoing', outcome: 'live', audioOnly: false, startedAt: '2026-10-06T11:00:00.000Z', endedAt: null, durationMs: null, people: [{ id: 'u-lena', name: 'Lena' }] }],
    recordings: [
      { id: 'r1', callId: 'c1', conversationId: DM, startedAt: '2026-10-06T11:00:00.000Z', endedAt: '2026-10-06T11:20:00.000Z', durationMs: 1_200_000, stage: 'ready', people: [] },
      { id: 'r2', callId: 'gone', conversationId: TEAMCH, startedAt: '2026-10-06T08:00:00.000Z', endedAt: '2026-10-06T08:10:00.000Z', durationMs: 600_000, stage: 'transcribing', people: [] },
    ],
    decks: [{ id: 'd1', conversationId: GENERAL, title: 'Recap', updatedAt: '2026-10-06T09:30:00.000Z', ownerName: 'Mira' }],
    flowRuns: [{ id: 'sum-1', kind: 'social.summarize', scope: GENERAL, status: 'running', steps: [{ status: 'completed' }, { status: 'running' }], createdAt: '2026-10-06T10:30:00.000Z', updatedAt: '2026-10-06T10:31:00.000Z', finishedAt: null, leaseExpiresAt: '2026-10-06T12:30:00.000Z' }],
  }));
  const rel = out.edges.map(e => `${e.fromId}>${e.toId}:${e.relation}`);
  expect(rel).toEqual(expect.arrayContaining([
    `scall:c1>sconv:${DM}:runs-in`, 'srec:r1>scall:c1:derived-from', `srec:r2>sconv:${TEAMCH}:derived-from`,
    `sdeck:d1>sconv:${GENERAL}:derived-from`, `sflow:sum-1>sconv:${GENERAL}:operates-on`, 'steam:team-c>sconv:social:team:community:general:works-on',
  ]));
  const kinds = Object.fromEntries(out.nodes.map(n => [n.id, n.kind]));
  expect(kinds).toMatchObject({ 'scall:c1': 'meeting', 'srec:r1': 'transcript', 'sdeck:d1': 'document', 'sflow:sum-1': 'run', [`sconv:${DM}`]: 'project', 'steam:team-c': 'project' });
  // Only a running RUN carries an operation (the contract admits run/agent/terminal processes), never a call.
  expect(out.operations.map(o => o.processNodeId)).toEqual(['sflow:sum-1']);
  expect(out.nodes.find(n => n.id === 'scall:c1')!.capabilities).toEqual(['join-meeting']);
});

it('a conversation page draws that conversation only, even when the viewer reads others', () => {
  const out = projectSocialWorkGraph(base({ scope: 'conversation', focusConversationId: DM }));
  expect(ids(out)).toEqual([`sconv:${DM}`]);
  const none = projectSocialWorkGraph(base({ scope: 'conversation', focusConversationId: 'social:ch:unknown' }));
  expect(none.nodes).toEqual([]);
});

it('read gates only mark capabilities; they never widen what is drawn', () => {
  const full = projectSocialWorkGraph(base());
  const ro = projectSocialWorkGraph(base({ reads: { view: true, post: false, call: false } }));
  expect(ids(ro)).toEqual(ids(full));
  expect(ro.nodes.every(n => n.capabilities.length === 0)).toBe(true);
  expect(full.nodes.some(n => n.capabilities.includes('message'))).toBe(true);
});

it('statuses are the row\'s own', () => {
  expect(callStatus({ outcome: 'ringing', endedAt: null })).toBe('waiting');
  expect(callStatus({ outcome: 'answered', endedAt: null })).toBe('running');
  expect(callStatus({ outcome: 'answered', endedAt: AT })).toBe('completed');
  expect(callStatus({ outcome: 'missed', endedAt: AT })).toBe('stopped');
  expect(recordingStatus('ready')).toBe('completed'); expect(recordingStatus('failed')).toBe('error'); expect(recordingStatus('transcribing')).toBe('running');
  expect(sNodeIdFor.conversation(DM)).toBe(`sconv:${DM}`);
  expect(sNodeIdFor.conversation(`social:ch:${'x'.repeat(150)}`)).toMatch(/^sconv:h\.[0-9a-f]{24}$/);
});

it('the policy revision changes with every gate and is namespaced', () => {
  const a = socialPolicyRevisionFor('s', { view: true, post: true, call: true }, []);
  expect(a).toMatch(/^social\.[0-9a-f]{24}$/);
  expect(socialPolicyRevisionFor('s', { view: true, post: false, call: true }, [])).not.toBe(a);
  expect(socialPolicyRevisionFor('s', { view: true, post: true, call: true }, ['call'])).not.toBe(a);
});
