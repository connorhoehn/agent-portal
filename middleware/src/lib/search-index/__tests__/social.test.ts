// The Social tenant's projection: what is built, who may see it, and that a
// write is searchable on the next query without a rebuild (S2).
jest.mock('../../../config.js', () => ({ config: { region: 'us-east-1', mock: { aurora: true, agentcore: true, guardrails: true, cloudwatch: true } } }));
jest.mock('../../authz.js', () => ({ isAllowed: jest.fn(async () => true) }));
import { createChannel } from '../../../providers/social-channels.js';
import { fixtureRegistry } from '../../../mock/core/index.js';
import { socialChat } from '../../social-chat.js';
import { __resetSearchIndex, ensureIndexed } from '../registry.js';
import { searchTenant } from '../tenant-query.js';

const as = (sub: string) => ({ sub, tenant: 'social', role: 'participant' });
const keys = async (sub: string, q: string) => (await searchTenant('social', as(sub), { q, limit: 20 })).results.map(r => `${r.type}:${r.id}`);

beforeEach(() => { fixtureRegistry.resetAll(); __resetSearchIndex(); });

test('the build holds channels, messages, pins, dms, contacts, teams, rooms, recordings and calls', async () => {
  const { index, partition, meta } = await ensureIndexed('social');
  expect(meta.retryAfter ?? null).toBeNull();
  const types = new Set((await index.query({ tenant: partition, terms: [] })).docs.map(d => d.type));
  for (const t of ['channel', 'message', 'pin', 'dm', 'contact', 'team', 'room', 'recording', 'calllog', 'huddle']) expect(types).toContain(t);
});

test('a channel row carries its owner and members', async () => {
  const [row] = (await searchTenant('social', as('u-mira'), { q: 'who owns #design-reviews' })).results;
  expect(row?.id).toBe('design-reviews');
  expect(row?.subtitle).toContain('Owner: Lena Brandt');
  expect(row?.subtitle).toContain('Members:');
});

test('a private channel and its messages are invisible to a non-member', async () => {
  expect((await keys('u-lena', 'moderation guidelines')).some(k => k.startsWith('pin:social:ch:moderators'))).toBe(true);
  expect((await keys('u-lena', '#moderators'))).toContain('channel:moderators');
  const outsider = await keys('u-sana', 'moderators two reports on the same thread');
  expect(outsider.filter(k => k.includes('moderators'))).toEqual([]);
});

test('a DM is visible to its participants only, and "my DM with" binds to the reader', async () => {
  expect((await keys('u-lena', 'my DM with Sana')).some(k => k.startsWith('dm:'))).toBe(true);
  expect((await keys('u-theo', 'DM Lena Sana')).some(k => k.startsWith('dm:social:dm:u-lena:u-sana'))).toBe(false);
  expect((await keys('u-theo', 'lightning talk slot confirmed')).some(k => k.includes('social:dm:u-lena:u-sana'))).toBe(false);
});

test('missed calls are the reader\'s own', async () => {
  expect((await keys('u-sana', 'missed calls')).length).toBeGreaterThan(0);
  expect(await keys('u-theo', 'missed calls')).toEqual([]);
});

test('a question in other word forms finds the message that answers it ("protect" → "duplicate-run protection")', async () => {
  const hits = (await searchTenant('social', as('u-lena'), { q: 'how do we protect the billing export from running twice', limit: 8 })).results;
  expect(hits.some(r => r.type === 'message' && /sized for a typical tenant/.test(r.title))).toBe(true);
  // A short "-tion" word is not rooted: "action" does not stand in for "act".
  const { tionRoot } = await import('../tokens.js');
  expect([tionRoot('transcription'), tionRoot('connections'), tionRoot('action'), tionRoot('nation')]).toEqual(['transcript', 'connect', null, null]);
});

test('a recording is found by its transcript by a participant, not by an outsider', async () => {
  expect(await keys('u-sana', 'event calendar goes live on Friday')).toContain('recording:mock-rec-town-hall-1');
  expect(await keys('u-theo', 'event calendar goes live on Friday')).not.toContain('recording:mock-rec-town-hall-1');
});

test('a created channel and a posted message are searchable without a rebuild', async () => {
  const before = await ensureIndexed('social');
  await createChannel({ slug: 'quokka-club', name: 'Quokka club', description: 'Marsupials only', privacy: 'public', createdBy: 'u-mira' });
  expect(await keys('u-sana', 'quokka')).toContain('channel:quokka-club');
  const chat = socialChat();
  await chat.chatStore.putMessage({ id: 'zzquokka1', clientId: 'x', userId: 'u-mira', channel: 'social:ch:general', message: 'Wombat standup moved to noon', metadata: { displayName: 'Mira Okafor' }, timestamp: new Date().toISOString() });
  await new Promise(r => setTimeout(r, 50));
  expect(await keys('u-sana', 'wombat standup')).toContain('message:social:ch:general|zzquokka1');
  expect((await ensureIndexed('social')).meta.builtAt).toBe(before.meta.builtAt);
});

test('a dated row carries its source time, so a reader can ask "since yesterday" (voice activity, G6); an undated one carries none', async () => {
  const missed = (await searchTenant('social', as('u-sana'), { q: 'missed calls', type: 'calllog', limit: 20 })).results;
  expect(missed.length).toBeGreaterThan(0);
  for (const r of missed) expect(Date.parse(r.updatedAt!)).not.toBeNaN();
  const messages = (await searchTenant('social', as('u-sana'), { q: '', type: 'message', limit: 5 })).results;
  expect(messages.length).toBeGreaterThan(0);
  const times = messages.map(r => r.updatedAt!);
  expect([...times].sort().reverse()).toEqual(times);
  const contacts = (await searchTenant('social', as('u-sana'), { q: 'Lena', type: 'contact', limit: 5 })).results;
  for (const r of contacts) expect(r.updatedAt).toBeUndefined();
});
