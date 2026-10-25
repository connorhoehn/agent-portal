jest.mock('../../config.js', () => ({ config: { region: 'us-east-1', auth: { sessionSigningSecretArn: '' }, cognito: { portalOrigin: '' }, mock: { aurora: true } } }));
import { identityClonesFixture, liveClones, removeClone } from '../identity-clones.js';
import { fixtureRegistry, freezeClock, unfreezeClock, createMockScope, runInMockScope, clearMockScopes } from '../core/index.js';
import { socialChannelMessagesFixture, socialChannelMembersFixture, socialDmJoinsFixture, socialReadCursorsFixture, socialPinsFixture } from '../social-channels.js';
import { gatewayReactionsFixture, gatewayUploadsFixture } from '../gateway-attachments.js';
import { createMemorySocialChatBackend, setSocialChatBackend } from '../../lib/social-chat.js';
import { mirrorCloneDms } from '../../lib/clone-dms.js';
import type { ChatMessage } from '@connorhoehn/realtime-modules/chat';

const clone = 'u-lena-clone-a1b2c3d4';
const other = 'u-lena-clone-b2c3d4e5';
const original = 'social:dm:u-lena:u-mira';
const own = `social:dm:${clone}:u-mira`;
const otherDm = `social:dm:${other}:u-mira`;
const fixtures = [socialChannelMessagesFixture, socialChannelMembersFixture, socialDmJoinsFixture, socialReadCursorsFixture, socialPinsFixture, gatewayReactionsFixture, gatewayUploadsFixture];
const message = (channel: string, id = channel): ChatMessage => ({ id, channel, userId: 'u-lena', clientId: 'test', message: 'Keep the original', timestamp: '2026-10-25T12:00:00.000Z' });
function addClone(id = clone) {
  identityClonesFixture.rows().push({ id, from: 'u-lena', label: 'test', displayName: 'Lena', email: null, personId: null,
    grants: { social: ['participant'] }, epoch: 0, createdAt: '2026-10-25T12:00:00.000Z', expiresAt: '2026-10-25T13:00:00.000Z' });
}
beforeEach(() => {
  freezeClock('2026-10-25T12:00:00.000Z');
  identityClonesFixture.reset(); clearMockScopes();
  for (const fixture of fixtures) { fixture.reset(); fixture.rows().splice(0); }
  addClone(); addClone(other);
});
afterEach(() => { setSocialChatBackend(null); identityClonesFixture.reset(); clearMockScopes(); unfreezeClock(); jest.restoreAllMocks(); });

it('deletion removes only the exact clone DM and related fixture rows across tenants', () => {
  const channels = [original, own, otherDm, `orgiq:dm:${clone}:u-vera`, `social:dm:${clone}-suffix:u-mira`, 'social:ch:general'];
  const kept = channels.filter(c => c !== own && !c.startsWith('orgiq:dm:'));
  const refresh = jest.fn(); setSocialChatBackend(createMemorySocialChatBackend(), refresh);
  for (const fixture of fixtures) {
    const field = fixture.key === 'social.pins' ? 'channelId' : 'channel';
    const rows = fixtureRegistry.get(fixture.key)!.rows();
    rows.push(...channels.map(channel => ({ [field]: channel, message: 'same text', userId: clone })));
  }
  expect(removeClone(clone)).toBe(true);
  for (const fixture of fixtures) {
    const field = fixture.key === 'social.pins' ? 'channelId' : 'channel';
    expect(fixtureRegistry.get(fixture.key)!.rows()).toEqual(kept.map(channel => ({ [field]: channel, message: 'same text', userId: clone })));
  }
  expect(identityClonesFixture.rows().map(c => c.id)).toEqual([other]);
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(removeClone(clone)).toBe(false);
  expect(refresh).toHaveBeenCalledTimes(1);
});

it('expiry discovered in a scope removes shared and scoped DM copies but preserves other conversations', () => {
  socialChannelMessagesFixture.rows().push(message(original), message(own), message(otherDm));
  socialDmJoinsFixture.rows().push({ channel: own, userId: clone }, { channel: otherDm, userId: other });
  const scope = createMockScope({ base: 'default' });
  const scoped = runInMockScope(scope, () => socialChannelMessagesFixture.rows());
  identityClonesFixture.rows().find(c => c.id === clone)!.expiresAt = '2026-10-25T12:00:00.000Z';
  expect(runInMockScope(scope, liveClones).map(c => c.id)).toEqual([other]);
  expect(socialChannelMessagesFixture.rows().map(m => m.channel)).toEqual([original, otherDm]);
  expect(scoped.map(m => m.channel)).toEqual([original, otherDm]);
  expect(socialDmJoinsFixture.rows()).toEqual([{ channel: otherDm, userId: other }]);
});

it('deletion makes fixture-backed DM history and the conversation index empty immediately', async () => {
  const chat = createMemorySocialChatBackend(); setSocialChatBackend(chat);
  socialChannelMessagesFixture.rows().push(message(original, 'original'));
  await mirrorCloneDms(clone);
  expect(await chat.chatStore.listMessages(own, 100)).toHaveLength(1);
  removeClone(clone);
  expect(await chat.chatStore.listMessages(own, 100)).toEqual([]);
  expect(await chat.conversations.listForUser(clone)).toEqual([]);
  expect(await chat.chatStore.listMessages(original, 100)).toEqual([message(original, 'original')]);
});

it.each(['deleted', 'expired'])('does not recreate a clone %s while history is loading', async state => {
  const chat = createMemorySocialChatBackend(); setSocialChatBackend(chat);
  socialChannelMessagesFixture.rows().push(message(original, 'original'));
  const read = chat.chatStore.listMessages.bind(chat.chatStore);
  let resume!: () => void;
  let entered!: () => void;
  const loading = new Promise<void>(resolve => { entered = resolve; });
  jest.spyOn(chat.chatStore, 'listMessages').mockImplementation(async (channel, limit) => {
    if (channel === original) { entered(); await new Promise<void>(resolve => { resume = resolve; }); }
    return read(channel, limit);
  });
  const pending = mirrorCloneDms(clone);
  await loading;
  if (state === 'deleted') removeClone(clone);
  else identityClonesFixture.rows().find(c => c.id === clone)!.expiresAt = '2026-10-25T12:00:00.000Z';
  resume(); await pending;
  expect(await read(own, 100)).toEqual([]);
  expect(await chat.conversations.listForUser(clone)).toEqual([]);
  expect(await read(original, 100)).toHaveLength(1);
});

it('a queued mirror cannot repopulate a deleted clone after an earlier mirror finishes', async () => {
  const chat = createMemorySocialChatBackend(); setSocialChatBackend(chat);
  socialChannelMessagesFixture.rows().push(message(original, 'original'));
  let resume!: () => void;
  chat.ready = new Promise<void>(resolve => { resume = resolve; });
  const first = mirrorCloneDms(clone), second = mirrorCloneDms(clone);
  removeClone(clone); resume(); await Promise.all([first, second]);
  expect(await chat.chatStore.listMessages(own, 100)).toEqual([]);
});

it('deletion during an awaited message write cannot leave a new conversation index row', async () => {
  const chat = createMemorySocialChatBackend(); setSocialChatBackend(chat);
  socialChannelMessagesFixture.rows().push(message(original, 'original'));
  const put = chat.chatStore.putMessage.bind(chat.chatStore);
  jest.spyOn(chat.chatStore, 'putMessage').mockImplementation(async row => {
    await put(row);
    removeClone(clone);
  });
  const record = jest.spyOn(chat.conversations, 'recordDmMessage');
  await mirrorCloneDms(clone);
  expect(await chat.chatStore.listMessages(own, 100)).toEqual([]);
  expect(record).not.toHaveBeenCalled();
});
