// A missed page huddle (orgiq initiative, assessment team / document, pipelines run) reaches the
// bell the way a missed DM does: only the people rung, only inside the tenant they hold a grant in,
// linking to the page. Delivery to a rung person who is not a current reader of the page is refused
// per recipient by directRecipientFilter (the page lobby guard), whatever the stored row says.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', aurora: {}, auth: {}, cognito: {}, mock: { aurora: true } } }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
import { getUser } from '../../providers/identity.js';
import { directRecipientFilter } from '../direct-recipient.js';
import { conversationHref, pageHuddleHref, setNotificationSink, type NotificationInputLike } from '../social-notify.js';
import { notifyMissedCall, recordInvite } from '../realtime-gateway.js';

const TEAM = 'assessment:team:TEAM-1';
const RUN = 'pipelines:run:r-1';
type Sent = { userId: string; input: NotificationInputLike };
let sent: Sent[];
beforeEach(() => {
  sent = [];
  setNotificationSink({ notifyUser: async (userId, input) => { sent.push({ userId, input }); return {}; } });
});
afterEach(() => setNotificationSink(null));

it('maps every tenant page lobby to its own page and keeps the tenant home as the fallback', () => {
  expect(pageHuddleHref('orgiq:initiative:p-auth')).toBe('/iq/projects/p-auth');
  expect(pageHuddleHref(TEAM)).toBe('/assessment/teams/TEAM-1');
  expect(pageHuddleHref(RUN)).toBe('/pipelines/runs/r-1');
  expect(pageHuddleHref('assessment:doc:x', 'assessment-document:/assessment/workspace?doc=page:1')).toBe('/assessment/workspace?doc=page:1');
  expect(pageHuddleHref('assessment:team:../x')).toBeNull();
  expect(conversationHref('pipelines', 'pipelines:other')).toBe('/pipelines/runs');
  expect(conversationHref('assessment', 'assessment:other')).toBe('/assessment/teams');
});

it.each([
  ['u-farah', TEAM, ['u-jonas'], '/assessment/teams/TEAM-1'],
  ['u-ines', RUN, ['u-kofi'], '/pipelines/runs/r-1'],
])('notifies only the people rung when a %s page huddle goes unanswered', async (caller, lobby, rung, href) => {
  const tenant = lobby.split(':')[0]!;
  recordInvite('invite', { callId: `c-${lobby}`, targetUserIds: [...rung, caller], channel: lobby });
  recordInvite('invite', { callId: `c-${lobby}`, targetUserIds: ['u-never-granted'], channel: lobby });
  await notifyMissedCall({ callId: `c-${lobby}`, lobbyName: lobby, callerId: caller, callerName: caller, reason: 'cancelled' });
  const got = sent.map(s => s.userId);
  expect(got).not.toContain(caller);
  expect(got).not.toContain('u-never-granted');
  for (const user of got) expect(rung).toContain(user);
  for (const s of sent) expect(s.input).toMatchObject({ type: 'call-missed', payload: { tenant, kind: 'call-missed', lobbyName: lobby }, action: { href } });
});

it('never notifies when nobody was rung (an empty-target page huddle)', async () => {
  recordInvite('invite', { callId: 'c-empty', targetUserIds: [], channel: TEAM });
  await notifyMissedCall({ callId: 'c-empty', lobbyName: TEAM, callerId: 'u-farah', reason: 'no-answer' });
  expect(sent).toEqual([]);
});

it('delivers a stored page-huddle missed call only to a current reader of that page', async () => {
  jest.mocked(getUser).mockResolvedValue({ id: 'u', displayName: 'U', email: null, personId: null, epoch: 1, grants: { assessment: ['assessor'] } } as never);
  const ctx = { userId: 'u', org: 'assessment', role: 'assessor', epoch: 1, sessionIat: 1, tenants: ['assessment'] };
  const item = { id: 'm1', title: 'Missed call', type: 'call-missed', channel: TEAM,
    payload: { tenant: 'assessment', kind: 'call-missed', lobbyName: TEAM, channel: TEAM }, action: { href: '/assessment/teams/TEAM-1' } };
  const message = { type: 'notification:bulk-update', payload: { notifications: [item] } };
  const reader = directRecipientFilter({ guard: (_a: unknown, l: string) => l === TEAM, getLobby: async () => TEAM });
  const outsider = directRecipientFilter({ guard: () => false, getLobby: async () => TEAM });
  expect(await reader({ clientId: 'c', ctx, message })).toEqual(message);
  expect(await outsider({ clientId: 'c', ctx, message })).toEqual({ type: 'notification:bulk-update', payload: { notifications: [] } });
});
