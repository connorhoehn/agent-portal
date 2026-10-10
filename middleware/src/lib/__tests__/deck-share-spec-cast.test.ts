// Pins the seed membership portal/e2e/assessment-decks-real.spec.ts case (f)
// depends on. The expanded social seed (mock/social-history.ts EXTRA_MEMBERS)
// put every social grant holder, u-vera included, into #general, so a "non-member
// of #general" no longer exists and the spec shares into #design-reviews instead.
// If this fails, the spec's casting is wrong, not necessarily the upload guard.
jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
jest.mock('../../providers/identity.js', () => ({ getUser: jest.fn() }));
jest.mock('../authz.js', () => ({ isAllowed: jest.fn() }));
import { getUser, type UserInfo } from '../../providers/identity.js';
import { isAllowed } from '../authz.js';
import { authorizeLiveGatewayChannel } from '../live-principal.js';
import { channelGuard, stripServicePrefix } from '../realtime-gateway.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../social-chat.js';
import { activeMembers, socialChannelMembersFixture } from '../../mock/social-channels.js';

const SOURCE = 'social:ch:design-reviews';
const members = (channel: string) => activeMembers(socialChannelMembersFixture.rows(), channel).map(m => m.userId);
const user = (id: string): UserInfo => ({ id, displayName: id, email: null, personId: null, epoch: 1, grants: { social: ['participant'] } });
const ask = (userId: string, channel: string) => authorizeLiveGatewayChannel(
  { kind: 'subscribe', clientId: 'http', channel, ctx: { userId, org: 'social', role: 'participant', epoch: 1, sessionIat: 1, tenants: ['social'], displayName: userId } },
  { guard: channelGuard, baseChannel: stripServicePrefix });

beforeEach(() => {
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
  jest.mocked(getUser).mockImplementation(async id => user(id));
  jest.mocked(isAllowed).mockImplementation(async (p, a) => p.role === 'participant' && ['ViewSocial', 'PostMessage'].includes(a));
});
afterEach(() => { socialChannelMembersFixture.reset(); setSocialChatBackend(null); });

describe('deck share spec (f) casting', () => {
  it('u-vera is a member of #general in the current seed, so #general cannot host the refusal', () => {
    expect(members('social:ch:general')).toEqual(expect.arrayContaining(['u-farah', 'u-theo', 'u-vera']));
  });

  it('#design-reviews holds the sharer and the downloader, not u-vera', () => {
    expect(members(SOURCE)).toEqual(expect.arrayContaining(['u-farah', 'u-theo']));
    expect(members(SOURCE)).not.toContain('u-vera');
  });

  it('the channel guard the upload GET asks admits the members and refuses u-vera', async () => {
    expect(await ask('u-theo', SOURCE)).toBe(true);
    expect(await ask('u-farah', SOURCE)).toBe(true);
    expect(await ask('u-vera', SOURCE)).toBe(false);
  });
});
