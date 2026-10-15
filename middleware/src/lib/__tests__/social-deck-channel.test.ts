// `social:deck:<id>` (lib/social-deck-channel.ts): presence-only, admitted to the
// deck's owner or a CURRENT member of its source conversation, asked fresh every
// time against the deck row and the directory. Drives the gateway's real
// authorizeLiveGatewayChannel + channelGuard.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { authorizeLiveGatewayChannel } from '../live-principal.js';
import { channelGuard, lobbyGuard } from '../realtime-gateway.js';
import { baseChannel } from '@connorhoehnslalom/realtime-modules/server';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../social-chat.js';
import { socialChannelMembersFixture } from '../../mock/social-channels.js';
import { socialDecksFixture } from '../../mock/social-decks.js';
import { inSocialDeckNamespace, parseSocialDeckChannel, socialDeckPresenceChannel } from '../social-deck-channel.js';

const DECK = 'sdeck-0b1c2d3e-0000-4000-8000-000000000001';
const CHANNEL = 'social:ch:general';
const POLICY: Record<string, string[]> = { participant: ['ViewSocial', 'PostMessage'], mute: [], member: [] };
let users: Map<string, UserInfo>;
let duringPolicy: (() => void) | null;
const user = (id: string, grants: Record<string, string[]>): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants });
const ctxOf = (userId: string, org = 'social') =>
  ({ userId, org, role: 'participant', epoch: 1, sessionIat: 1, tenants: Object.keys(users.get(userId)?.grants ?? {}), displayName: userId });
const ask = (who: string, channel: string, kind: 'subscribe' | 'publish' = 'subscribe', org = 'social') =>
  authorizeLiveGatewayChannel({ kind, clientId: 'c', channel, ctx: ctxOf(who, org) }, { guard: channelGuard, baseChannel });
const wire = socialDeckPresenceChannel(DECK);

beforeEach(() => {
  duringPolicy = null;
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  socialDecksFixture.rows().unshift({ id: DECK, channel: CHANNEL, runId: null, title: 'T', createdBy: 'u-sana', createdAt: 'x', updatedAt: 'x', headRevisionId: null });
  users = new Map([
    ['u-sana', user('u-sana', { social: ['participant'] })],
    ['u-theo', user('u-theo', { social: ['participant'], orgiq: ['member'] })],
    ['u-outside', user('u-outside', { social: ['participant'] })],
    ['u-mute', user('u-mute', { social: ['mute'] })],
    ['u-org', user('u-org', { orgiq: ['member'] })],
  ]);
  jest.mocked(getUser).mockImplementation(async id => structuredClone(users.get(id) ?? null));
  jest.mocked(isAllowed).mockImplementation(async (p, a) => {
    const ok = (POLICY[p.role] ?? []).includes(a);
    duringPolicy?.();
    return ok;
  });
});
afterEach(() => { socialChannelMembersFixture.reset(); socialDecksFixture.reset(); setSocialChatBackend(null); });

describe('social:deck:<id> presence', () => {
  it('admits the owner and a current member of the source conversation, to subscribe and publish presence', async () => {
    for (const who of ['u-sana', 'u-theo']) {
      expect(await ask(who, wire)).toBe(true);
      expect(await ask(who, wire, 'publish')).toBe(true);
    }
  });

  it('refuses a Social member who is not in the source conversation, an unknown deck and a person with no Social grant', async () => {
    expect(await ask('u-outside', wire)).toBe(false);
    expect(await ask('u-outside', wire, 'publish')).toBe(false);
    expect(await ask('u-sana', socialDeckPresenceChannel('sdeck-0b1c2d3e-0000-4000-8000-0000000000ff'))).toBe(false);
    expect(await ask('u-org', wire, 'subscribe', 'orgiq')).toBe(false);
    expect(await ask('u-mute', wire)).toBe(false);
    expect(await ask('nobody', wire)).toBe(false);
  });

  it('is presence only: bare names and every other service are refused, as are malformed ids', async () => {
    for (const name of [`social:deck:${DECK}`, `chat:social:deck:${DECK}`, `reactions:social:deck:${DECK}`, `cursor:social:deck:${DECK}`,
      `typing:social:deck:${DECK}`, `pins:social:deck:${DECK}`, `activity:social:deck:${DECK}`]) {
      for (const kind of ['subscribe', 'publish'] as const) expect(await ask('u-sana', name, kind)).toBe(false);
    }
    for (const name of ['presence:social:deck:', 'presence:social:deck:deck-1', 'presence:social:deck:a b', `presence:social:deck:${'x'.repeat(257)}`,
      `presence:social:deck:${DECK}:x`, 'presence:social:deck', 'presence:social:deck:sdeck-../x']) {
      expect(await ask('u-sana', name)).toBe(false);
    }
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, `social:deck:${DECK}`)).toBe(false);
    expect(channelGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, wire)).toBe(true);
    expect(channelGuard({ userId: 'u-sana', org: 'orgiq', tenants: ['orgiq'] }, wire)).toBe(false);
  });

  it('is never a call lobby', () => {
    expect(lobbyGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, `social:deck:${DECK}`)).toBe(false);
    expect(lobbyGuard({ userId: 'u-sana', org: 'social', tenants: ['social'] }, 'social:deck:x')).toBe(false);
  });

  it('is decided fresh: a removed member loses it, the owner keeps it while granted, and a mid-check revocation denies', async () => {
    expect(await ask('u-theo', wire)).toBe(true);
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-theo')!.removedAt = new Date().toISOString();
    expect(await ask('u-theo', wire)).toBe(false);
    socialChannelMembersFixture.rows().find(m => m.channel === CHANNEL && m.userId === 'u-sana')!.removedAt = new Date().toISOString();
    expect(await ask('u-sana', wire)).toBe(true); // the owner reads their own deck
    duringPolicy = () => { users.set('u-sana', user('u-sana', {})); };
    expect(await ask('u-sana', wire)).toBe(false);
  });

  it('parses only well-formed names', () => {
    expect(parseSocialDeckChannel(`social:deck:${DECK}`)).toEqual({ deckId: DECK });
    expect(parseSocialDeckChannel('social:deck:x')).toBeNull();
    expect(inSocialDeckNamespace('social:deck:anything')).toBe(true);
    expect(inSocialDeckNamespace('social:decks')).toBe(false);
  });
});
