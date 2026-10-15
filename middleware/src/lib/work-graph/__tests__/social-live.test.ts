// The social work graph's live side: the `social:workgraph` family (lib/tenant-channels.ts), the router authorization
// that adds the conversation's own chat read (lib/live-principal.ts authorizeSocialWorkGraphChannel), the content-free
// hint (lib/work-graph/live.ts), and the seams that feed it (chat store, membership, the call state store).
//
// Pinned: only the plain subscribe is offered on the name; a member reads the conversation's stream, a non-member's
// subscribe is refused and so is every other tenant, a malformed name, a publish, presence; the fallback hint names
// NOTHING (not a conversation, not a person); a message, a membership change and a call each tell the graph once, by
// conversation, without carrying content; a burst recomputes once per window.
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../../providers/identity.js', () => ({ ...jest.requireActual('../../../providers/identity.js'), getUser: jest.fn() }));
jest.mock('../../authz.js', () => ({ ...jest.requireActual('../../authz.js'), isAllowed: jest.fn() }));
import { InMemoryCallStateStore } from '@connorhoehnslalom/realtime-modules/call';
import { getUser, type UserInfo } from '../../../providers/identity.js';
import { isAllowed } from '../../authz.js';

import { channelGuard, lobbyGuard } from '../../realtime-gateway.js';
import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { tenantChannelFamily } from '../../tenant-channels.js';
import { createMemorySocialChatBackend, setSocialChatBackend, socialChat } from '../../social-chat.js';
import { observeCallPageLifecycle } from '../../call-pages.js';
import { resetGatewayRunFeed, tenantActivity } from '../../gateway-run-feed.js';
import { SOCIAL_WORK_GRAPH_CHANNEL, WORK_GRAPH_HINT, coalescedSocialHint, notifySocialWorkGraphChanged, resetSocialHintCoalescing, stopWorkGraphLiveHints } from '../live.js';
import { onSocialWorkGraphEvent, resetObservedCalls, observedCalls, type SocialWorkGraphEvent } from '../social-events.js';
import { admitChannel } from '../../gateway/authority.js';

let users: Map<string, UserInfo>;
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants });
const ctx = (userId: string, org: string, role: string) =>
  ({ userId, org, role, epoch: 1, sessionIat: 1, tenants: Object.keys(users.get(userId)?.grants ?? {}), displayName: userId });
const guards = { guard: channelGuard, baseChannel };
const authorize = (c: ReturnType<typeof ctx>, channel: string, kind: 'subscribe' | 'publish' = 'subscribe') =>
  admitChannel({ kind, clientId: 'socket', channel, ctx: c });
const SECRET = 'social:ch:secret';
const WS = 'social:workgraph:workspace';
const CONV = `social:workgraph:conversation:${SECRET}`;
const when = '2026-10-06T12:00:00.000Z';

beforeAll(() => stopWorkGraphLiveHints());
beforeEach(async () => {
  resetGatewayRunFeed(); resetObservedCalls(); resetSocialHintCoalescing();
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: false }));
  const chat = socialChat();
  await chat.membershipStore.putMember({ channel: SECRET, userId: 'sara', role: 'owner', addedBy: 'sara', addedAt: when, historyFrom: null, removedAt: null });
  users = new Map([
    ['sara', user('sara', { social: ['participant'] })],
    ['sam', user('sam', { social: ['participant'] })],       // holds ViewSocial, is NOT in #secret
    ['blind', user('blind', { social: ['member'] })],       // a social grant whose role holds no Social action
    ['theo', user('theo', { orgiq: ['member'] })],
    ['ines', user('ines', { pipelines: ['author'] })],
    ['ana', user('ana', { assessment: ['assessor'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, action) => p.role === 'participant' && ['ViewSocial', 'PostMessage', 'StartCall'].includes(action));
});
afterEach(() => { jest.clearAllMocks(); jest.useRealTimers(); });

describe('social:workgraph family (default deny)', () => {
  it('offers only the plain subscribe: workspace for a ViewSocial session, a conversation for its members', async () => {
    expect(tenantChannelFamily(SOCIAL_WORK_GRAPH_CHANNEL)?.id).toBe('social:workgraph');
    expect(tenantChannelFamily(WS)?.id).toBe('social:workgraph');
    expect(tenantChannelFamily(CONV)?.id).toBe('social:workgraph');
    for (const name of [SOCIAL_WORK_GRAPH_CHANNEL, WS]) {
      expect(await authorize(ctx('sara', 'social', 'participant'), name)).toBe(true);
      expect(await authorize(ctx('sam', 'social', 'participant'), name)).toBe(true);
    }
    expect(await authorize(ctx('sara', 'social', 'participant'), CONV)).toBe(true);
    // Never a publish, presence or reactions; never another tenant; never a viewer without ViewSocial.
    for (const name of [WS, CONV]) {
      expect(await authorize(ctx('sara', 'social', 'participant'), name, 'publish')).toBe(false);
      expect(await authorize(ctx('sara', 'social', 'participant'), `presence:${name}`)).toBe(false);
      expect(await authorize(ctx('sara', 'social', 'participant'), `reactions:${name}`)).toBe(false);
      expect(await authorize(ctx('blind', 'social', 'member'), name)).toBe(false);
      for (const [who, org, role] of [['theo', 'orgiq', 'member'], ['ines', 'pipelines', 'author'], ['ana', 'assessment', 'assessor']] as const) {
        expect(await authorize(ctx(who, org, role), name)).toBe(false);
      }
    }
    for (const name of ['social:workgraph:', 'social:workgraph:team:x', 'social:workgraph:workspace:x', 'social:workgraph:conversation:',
      'social:workgraph:conversation:x', 'social:workgraph:conversation:orgiq:initiative:p-1', 'social:workgraph:conversation:social:ch:a b', 'social:workgraph:conversation:social:ch:../x']) {
      expect(await authorize(ctx('sara', 'social', 'participant'), name)).toBe(false);
    }
    expect(lobbyGuard({ userId: 'sara', org: 'social', tenants: ['social'] }, WS)).toBe(true); // the partition rule alone: a lobby is still refused below
    expect(tenantChannelFamily(WS)?.lobby).toBe(false);
  });

  it('a non-member holding ViewSocial is refused a private conversation\'s stream, and a removed member loses it at once', async () => {
    expect(await authorize(ctx('sam', 'social', 'participant'), CONV)).toBe(false);
    expect(await authorize(ctx('sara', 'social', 'participant'), CONV)).toBe(true);
    const chat = socialChat();
    const row = (await chat.membershipStore.getMember(SECRET, 'sara'))!;
    await chat.membershipStore.putMember({ ...row, removedAt: when });
    expect(await authorize(ctx('sara', 'social', 'participant'), CONV)).toBe(false);
    // A DM names its two people; a third holding ViewSocial is refused.
    expect(await authorize(ctx('sara', 'social', 'participant'), 'social:workgraph:conversation:social:dm:sara:sam')).toBe(true);
    expect(await authorize(ctx('sam', 'social', 'participant'), 'social:workgraph:conversation:social:dm:sara:sam')).toBe(true);
    expect(await authorize(ctx('blind', 'social', 'member'), 'social:workgraph:conversation:social:dm:sara:sam')).toBe(false);
  });
});

describe('the social hint', () => {
  it('reaches Social readers only and names nothing: not a conversation, a person or a cause beyond `activity`', async () => {
    const received: unknown[] = [];
    const members = new Map<string, Set<string>>();
    const contexts = new Map<string, ReturnType<typeof ctx>>();
    const router = {
      sendToClient: (to: string, message: Record<string, unknown>) => { received.push({ to, message }); return true; },
      sendToChannel: async (channel: string, message: Record<string, unknown>) => { for (const to of members.get(channel) ?? []) received.push({ to, message }); },
      checkChannel: (kind: 'subscribe' | 'publish', clientId: string, channel: string) => admitChannel({ kind, clientId, channel, ctx: contexts.get(clientId) ?? null }),
      subscribeToChannel: async (clientId: string, channel: string) => {
        if (!await router.checkChannel('subscribe', clientId, channel)) return false;
        const set = members.get(channel) ?? new Set<string>(); set.add(clientId); members.set(channel, set); return true;
      },
      unsubscribeFromChannel: (clientId: string, channel: string) => { members.get(channel)?.delete(clientId); },
    };
    const service = tenantActivity().create({ router: router as never, logger: { debug() {}, info() {}, warn() {}, error() {} } });
    contexts.set('sam-socket', ctx('sam', 'social', 'participant'));
    contexts.set('theo-socket', ctx('theo', 'orgiq', 'member'));
    await service.handleAction('sam-socket', 'subscribe', { channelId: SOCIAL_WORK_GRAPH_CHANNEL });
    await service.handleAction('theo-socket', 'subscribe', { channelId: SOCIAL_WORK_GRAPH_CHANNEL });
    expect([...(members.get(SOCIAL_WORK_GRAPH_CHANNEL) ?? [])]).toEqual(['sam-socket']);
    await notifySocialWorkGraphChanged(SECRET, 'message');
    await notifySocialWorkGraphChanged('social:dm:sara:sam', 'call');
    await notifySocialWorkGraphChanged(null, 'recording');
    const details = (received as Array<{ to: string; message: { type: string; payload?: { eventType: string; detail: unknown } } }>)
      .filter(r => r.message.type === 'activity:event').map(r => r.message.payload!);
    expect(details.map(d => d.eventType)).toEqual([WORK_GRAPH_HINT, WORK_GRAPH_HINT, WORK_GRAPH_HINT]);
    expect(details.map(d => d.detail)).toEqual([{ cause: 'activity' }, { cause: 'activity' }, { cause: 'activity' }]);
    expect(JSON.stringify(received)).not.toMatch(/secret|sara|sam"?:?dm|u-/);
  });

  it('a burst recomputes once per window, then once more with the last change', () => {
    jest.useFakeTimers();
    const sent: SocialWorkGraphEvent[] = [];
    const send = (e: SocialWorkGraphEvent) => { sent.push(e); };
    for (let i = 0; i < 5; i++) coalescedSocialHint({ conversationId: SECRET, cause: 'message' }, send);
    coalescedSocialHint({ conversationId: 'social:dm:a:b', cause: 'message' }, send);
    expect(sent).toHaveLength(2);                       // one per conversation, at once
    jest.advanceTimersByTime(300);
    expect(sent).toHaveLength(3);                       // the held change of #secret
    jest.advanceTimersByTime(300);
    expect(sent).toHaveLength(3);
  });
});

describe('the seams that feed the graph', () => {
  it('a stored message and a membership change tell the graph their conversation, never their content', async () => {
    const heard: SocialWorkGraphEvent[] = [];
    const stop = onSocialWorkGraphEvent(e => heard.push(e));
    const chat = socialChat();
    await chat.chatStore.putMessage({ id: 'm1', clientId: 'c', userId: 'sara', channel: SECRET, message: 'top secret text', timestamp: when } as never);
    await chat.chatStore.putMessage({ id: 'm2', clientId: 'c', userId: 'sara', channel: 'orgiq:initiative:p-1', message: 'x', timestamp: when } as never);
    await chat.membershipStore.putMember({ channel: SECRET, userId: 'sam', role: 'member', addedBy: 'sara', addedAt: when, historyFrom: null, removedAt: null });
    await chat.chatStore.updateMessage?.(SECRET, 'm1', { message: '', deletedAt: when } as never);
    stop();
    expect(heard).toEqual([
      { conversationId: SECRET, cause: 'message' }, { conversationId: SECRET, cause: 'membership' }, { conversationId: SECRET, cause: 'message' },
    ]);
    expect(JSON.stringify(heard)).not.toContain('top secret');
  });

  it('the call state store tells the graph when a call is placed, answered and ended, and when its recording lands', async () => {
    jest.useFakeTimers();
    const heard: SocialWorkGraphEvent[] = [];
    const stop = onSocialWorkGraphEvent(e => heard.push(e));
    const store = observeCallPageLifecycle(new InMemoryCallStateStore() as never, () => null);
    const lobby = 'social:dm:sana:sara';
    await store.registerParticipant('call-1', 'c1', 'sara', lobby, ['sana']);
    expect(observedCalls()).toMatchObject([{ callId: 'call-1', lobbyName: lobby, participants: 1, answered: false }]);
    await store.registerParticipant('call-1', 'c2', 'sara', lobby, ['sana']);
    expect(observedCalls()[0]).toMatchObject({ participants: 2, answered: true });
    await store.registerParticipant('orgiq-call', 'c3', 'ines', 'orgiq:initiative:p-1', []);   // not a social conversation: no event
    await store.forgetCall('call-1');
    expect(observedCalls().find(c => c.callId === 'call-1')).toMatchObject({ participants: 0, endedAt: expect.any(String) });
    jest.advanceTimersByTime(5_000);
    stop();
    expect(heard.map(e => `${e.conversationId}|${e.cause}`)).toEqual([`${lobby}|call`, `${lobby}|call`, `${lobby}|call`, `${lobby}|recording`]);
  });

  it('the last seat leaving ends the call for the graph, and a rejoin before the store forgets it brings it back', async () => {
    const heard: SocialWorkGraphEvent[] = [];
    const stop = onSocialWorkGraphEvent(e => heard.push(e));
    const store = observeCallPageLifecycle(new InMemoryCallStateStore() as never, () => null);
    const lobby = 'social:room:town-hall';
    await store.registerParticipant('call-2', 'c1', 'sara', lobby, []);
    await store.registerParticipant('call-2', 'c2', 'sara', lobby, []);
    await store.removeParticipant('call-2', 'c2');
    expect(observedCalls().find(c => c.callId === 'call-2')).toMatchObject({ participants: 1, endedAt: null });
    await store.removeParticipant('call-2', 'c1');
    expect(observedCalls().find(c => c.callId === 'call-2')).toMatchObject({ endedAt: expect.any(String) });
    stop();
    expect(heard.map(e => e.cause)).toEqual(['call', 'call', 'call', 'call']);
  });
});
