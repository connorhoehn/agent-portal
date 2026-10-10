// Slice 7 (docs/agentic-flows-migration.md): a recorded call's transcript as the
// source of `/summarize --recording <id>` and `/deck --from recording:<id>`.
// dev:mock backend (recordings and transcripts are registered fixtures).
const mockCaps = { current: ['ViewSocial', 'PostMessage'] };
jest.mock('../../config.js', () => ({
  config: { region: 'us-east-1', auth: { policyStoreId: undefined, sessionSigningSecretArn: '' },
    cognito: { portalOrigin: '' }, mock: { aurora: true, agentcore: true } },
}));
jest.mock('../../providers/index.js', () => ({ agentcore: { invokeAgent: jest.fn() } }));
jest.mock('../../lib/role-registry.js', () => ({
  roleRegistry: () => ['participant', 'moderator', 'community-admin']
    .map(id => ({ id, tenant: 'social', capabilities: mockCaps.current })),
}));

import express from 'express';
import request from '../../test-support/http.js';
import { chatPinsRouter } from '../chat-pins.js';
import { pendingSummaries, socialSummarizeRouter } from '../social-summarize.js';
import { pendingDecks, socialDeckRouter } from '../social-deck.js';
import { errorHandler } from '../../lib/async-handler.js';
import { realtimeClaims, signRealtimeToken } from '../../lib/realtime-token.js';
import { socialChat, setSocialChatBackend, createMemorySocialChatBackend } from '../../lib/social-chat.js';
import { getUser } from '../../providers/identity.js';
import { socialChannelMembersFixture, socialChannelMessagesFixture } from '../../mock/social-channels.js';
import { flowRunsFixture } from '../../mock/flow-runs.js';
import { socialDeckRevisionsFixture, socialDecksFixture } from '../../mock/social-decks.js';
import { socialRecordingTranscriptsFixture, socialRecordingsFixture } from '../../mock/social-platform.js';
import { parseDeckArgs } from '../../lib/social-deck/args.js';
import { parseSummarizeArgs } from '../../lib/social-summarize-args.js';
import { parseRecordingSegmentId, recordingConversation, recordingSegmentId, speechSegments } from '../../lib/recording-transcript.js';
import { hidePptxNodeDetection } from '../../test-support/pptxTestEnv.js';
import type { Session } from '../../lib/session.js';

const SECRET = 'recording-flows-test-secret';
const previousSecret = process.env['REALTIME_JWT_SECRET'];
const app = express();
app.use(express.json());
app.use('/api/chat', chatPinsRouter);
app.use('/api/chat/commands', socialSummarizeRouter);
app.use('/api/chat', socialDeckRouter);
app.use(errorHandler);

const DM = 'social:dm:u-lena:u-sana';
const REC = 'mock-rec-dm-lena-sana';
const NOW = new Date('2026-10-06T12:00:00.000Z');

async function bearer(sub: string): Promise<string> {
  const user = await getUser(sub);
  const session = { sub, name: user?.displayName, role: 'participant', tenant: 'social', grants: user?.grants ?? {}, iat: 0 } as Session;
  return `Bearer ${(await signRealtimeToken(realtimeClaims(session), SECRET)).token}`;
}
const auth = async (sub: string) => ({ Authorization: await bearer(sub) });
async function summarize(sub: string, channel: string, text: string) {
  return request(app).post('/api/chat/commands/summarize/run').set(await auth(sub)).send({ channel, text });
}
async function deck(sub: string, channel: string, text: string) {
  return request(app).post('/api/chat/commands/deck/run').set(await auth(sub)).send({ channel, text });
}
const settle = async (): Promise<void> => { await Promise.all([...pendingSummaries, ...pendingDecks]); };

let restorePptx: () => void;
beforeAll(() => { process.env['REALTIME_JWT_SECRET'] = SECRET; restorePptx = hidePptxNodeDetection(); });
afterAll(() => {
  restorePptx();
  if (previousSecret === undefined) delete process.env['REALTIME_JWT_SECRET']; else process.env['REALTIME_JWT_SECRET'] = previousSecret;
});
beforeEach(() => {
  mockCaps.current = ['ViewSocial', 'PostMessage'];
  setSocialChatBackend(createMemorySocialChatBackend({ fixtures: true }));
});
afterEach(() => {
  socialChannelMembersFixture.reset(); socialChannelMessagesFixture.reset(); flowRunsFixture.reset();
  socialDecksFixture.reset(); socialDeckRevisionsFixture.reset(); socialRecordingTranscriptsFixture.reset(); socialRecordingsFixture.reset();
  setSocialChatBackend(null);
});

describe('argument grammar', () => {
  it('/summarize takes --recording <id>, --recording=<id> and the picker\'s --from recording:<id>; a range still works without one', () => {
    for (const text of [`--recording ${REC}`, `--recording=${REC}`, `--from recording:${REC}`, `--from=recording:${REC}`]) {
      expect(parseSummarizeArgs(text, NOW)).toEqual({ ok: true, recordingId: REC, sinceMs: null, instruction: '' });
    }
    expect(parseSummarizeArgs(`focus on owners --from recording:${REC}`, NOW)).toMatchObject({ ok: true, recordingId: REC, instruction: 'focus on owners' });
    expect(parseSummarizeArgs('24h', NOW)).toMatchObject({ ok: true, recordingId: null, sinceMs: NOW.getTime() - 86_400_000, instruction: '24h' });
    expect(parseSummarizeArgs('', NOW)).toEqual({ ok: true, recordingId: null, sinceMs: null, instruction: '' });
    expect(parseSummarizeArgs('--recording', NOW)).toMatchObject({ ok: false });
    expect(parseSummarizeArgs('--recording ../x', NOW)).toMatchObject({ ok: false });
    expect(parseSummarizeArgs('--from transcript', NOW)).toMatchObject({ ok: false });
    expect(parseSummarizeArgs('--recording a --recording b', NOW)).toMatchObject({ ok: false });
    expect(parseSummarizeArgs('last banana', NOW)).toMatchObject({ ok: false });
  });

  it('/deck takes --from recording:<id> anywhere; a bare --from transcript names none and is refused', () => {
    const ok = parseDeckArgs(`Quarterly review --from recording:${REC} --preview`);
    expect(ok).toMatchObject({ ok: true, value: { topic: 'Quarterly review', preview: true, recordingId: REC } });
    expect(parseDeckArgs('topic').ok && (parseDeckArgs('topic') as { value: { recordingId: unknown } }).value.recordingId).toBeNull();
    expect(parseDeckArgs('--from transcript')).toMatchObject({ ok: false });
    expect(parseDeckArgs('--from')).toMatchObject({ ok: false });
    expect(parseDeckArgs('--from recording:a --from=recording:b')).toMatchObject({ ok: false });
  });

  it('segment ids round-trip, reactions are not speech, and only a DM call has a conversation', () => {
    expect(parseRecordingSegmentId(recordingSegmentId('r-1', 4))).toEqual({ recordingId: 'r-1', index: 4 });
    expect(speechSegments([{ text: ' a  b ', speakerLabel: 'X', startMs: 1 }, { text: 'x', kind: 'reaction' }, { text: '  ' }]).map(s => [s.index, s.text])).toEqual([[0, 'a b']]);
    expect(recordingConversation('social:dm:u-a:u-b')).toBe('social:dm:u-a:u-b');
    expect(recordingConversation('social:room:town-hall')).toBeNull();
  });
});

describe('/summarize --recording', () => {
  it('summarizes the transcript: every quote is verbatim in ONE segment, cited as recording:<id>#<segment>, nothing is posted', async () => {
    const started = await summarize('u-sana', DM, `--from recording:${REC}`);
    expect(started.status).toBe(202);
    await settle();
    const status = await request(app).get(`/api/chat/commands/summarize/runs/${started.body.runId}`).set(await auth('u-sana'));
    expect(status.body).toMatchObject({ phase: 'completed', posted: false });
    const segments = socialRecordingTranscriptsFixture.rows().find(r => r.recordingId === REC)!.segments;
    expect(status.body.result.messageCount).toBe(segments.length);
    expect(status.body.result.sourceSpans.length).toBeGreaterThan(0);
    for (const span of status.body.result.sourceSpans as Array<{ text: string; messageId: string; author: string }>) {
      const cite = parseRecordingSegmentId(span.messageId)!;
      expect(cite.recordingId).toBe(REC);
      expect(segments[cite.index]!.text).toContain(span.text);
      expect(segments[cite.index]!.speakerLabel).toBe(span.author);
    }
    // The post is the explicit act, and its metadata names the segments it cites.
    const posted = await request(app).post(`/api/chat/commands/summarize/runs/${started.body.runId}/post`).set(await auth('u-sana'));
    expect(posted.status).toBe(200);
    expect(posted.body.channel).toBe(DM);
    expect(posted.body.metadata.summaryOf.sourceMessageIds.every((id: string) => id.startsWith(`recording:${REC}#`))).toBe(true);
  });

  it('is private to the requester', async () => {
    const started = await summarize('u-sana', DM, `--recording ${REC}`);
    await settle();
    expect((await request(app).get(`/api/chat/commands/summarize/runs/${started.body.runId}`).set(await auth('u-lena'))).status).toBe(404);
  });

  it('refuses what the caller cannot read: another conversation, a room call, a recording they were not on, a non-member, an unknown id', async () => {
    // Town hall is a room: no conversation to carry the card.
    expect((await summarize('u-sana', DM, '--recording mock-rec-town-hall-1')).status).toBe(404);
    // The DM call belongs to Lena and Sana only: Mira is not a member of that conversation.
    expect((await summarize('u-mira', DM, `--recording ${REC}`)).status).toBe(403);
    expect((await summarize('u-sana', 'social:dm:u-mira:u-sana', `--recording ${REC}`)).status).toBe(404);
    expect((await summarize('u-sana', DM, '--recording nope')).status).toBe(404);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('a pending transcript is a 409 and a failed one a 422; no run is created', async () => {
    const t = socialRecordingTranscriptsFixture.rows().find(r => r.recordingId === REC)!;
    t.transcriptStatus = 'pending';
    expect((await summarize('u-sana', DM, `--recording ${REC}`)).status).toBe(409);
    t.transcriptStatus = 'failed';
    expect((await summarize('u-sana', DM, `--recording ${REC}`)).status).toBe(422);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });

  it('the thread summary is unchanged when no recording is named', async () => {
    const started = await summarize('u-sana', DM, '24h');
    expect(started.status).toBe(202);
    await settle();
  });
});

describe('/summarize --recording for a room call (the Recordings pane card)', () => {
  const ROOM = 'social:room:town-hall';
  const TH1 = 'mock-rec-town-hall-1';
  const runRoom = async (sub: string, recording = TH1, channel = ROOM) => summarize(sub, channel, `--recording ${recording}`);
  const statusOf = async (sub: string, id: string) => request(app).get(`/api/chat/commands/summarize/runs/${id}`).set(await auth(sub));
  const postOf = async (sub: string, id: string, channel?: string) =>
    request(app).post(`/api/chat/commands/summarize/runs/${id}/post`).set(await auth(sub)).send(channel ? { channel } : {});

  it('a participant summarizes the room call; nothing posts until Post names a channel they may write to', async () => {
    const started = await runRoom('u-sana');
    expect(started.status).toBe(202);
    await settle();
    const status = await statusOf('u-sana', started.body.runId);
    expect(status.body).toMatchObject({ phase: 'completed', posted: false });
    expect(status.body.result.sourceSpans.length).toBeGreaterThan(0);
    expect((await postOf('u-sana', started.body.runId)).status).toBe(400); // no target chosen
    expect((await postOf('u-sana', started.body.runId, 'social:ch:moderators')).status).toBe(403); // not a member of the target
    const posted = await postOf('u-sana', started.body.runId, 'social:ch:general');
    expect(posted.status).toBe(200);
    expect(posted.body.channel).toBe('social:ch:general');
    expect(posted.body.metadata.summaryOf.sourceMessageIds.every((id: string) => id.startsWith(`recording:${TH1}#`))).toBe(true);
    expect((await postOf('u-sana', started.body.runId, 'social:ch:general')).status).toBe(409); // once only
  });

  it('refuses a non-participant, a stranger to the run, another room, a missing --recording, and a user with no Social grant', async () => {
    // Lena was not on the second town hall call.
    expect((await runRoom('u-lena', 'mock-rec-town-hall-2')).status).toBe(404);
    // A different room lobby than the recording's own.
    expect((await runRoom('u-sana', TH1, 'social:room:other')).status).toBe(404);
    expect((await summarize('u-sana', ROOM, '24h')).status).toBe(400);
    expect((await runRoom('u-hr')).status).toBe(403);
    expect(flowRunsFixture.rows()).toHaveLength(0);
    const started = await runRoom('u-sana');
    await settle();
    expect((await statusOf('u-lena', started.body.runId)).status).toBe(404);
    expect((await postOf('u-lena', started.body.runId, 'social:ch:general')).status).toBe(404);
  });

  it('a pending transcript is a 409 and a failed one a 422; no run is created', async () => {
    const t = socialRecordingTranscriptsFixture.rows().find(r => r.recordingId === TH1)!;
    t.transcriptStatus = 'pending';
    expect((await runRoom('u-sana')).status).toBe(409);
    t.transcriptStatus = 'failed';
    expect((await runRoom('u-sana')).status).toBe(422);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });
});

describe('/deck --from recording', () => {
  it('builds slides whose sources are the recording\'s segments; a preview stores nothing', async () => {
    const started = await deck('u-sana', DM, `Call recap --from recording:${REC} --preview`);
    expect(started.status).toBe(202);
    await settle();
    const status = await request(app).get(`/api/chat/commands/deck/runs/${started.body.runId}`).set(await auth('u-sana'));
    expect(status.body).toMatchObject({ phase: 'completed', preview: true, deckId: null });
    const spec = status.body.result.spec as { slides: Array<{ sources: Array<{ documentId: string }> }> };
    const ids = spec.slides.flatMap(s => s.sources.map(x => x.documentId));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(id.startsWith(`recording:${REC}#`)).toBe(true);
    expect(status.body.result.sourceMessageIds.every((id: string) => id.startsWith(`recording:${REC}#`))).toBe(true);
    expect(status.body.result.messageCount).toBe(socialRecordingTranscriptsFixture.rows().find(r => r.recordingId === REC)!.segments.length);
    expect(socialDecksFixture.rows()).toHaveLength(0);
    // Save is the only write.
    const saved = await request(app).post(`/api/chat/commands/deck/runs/${started.body.runId}/save`).set(await auth('u-sana'));
    expect([200, 201]).toContain(saved.status);
    expect(socialDecksFixture.rows()).toHaveLength(1);
  });

  it('refuses the same things /summarize refuses, and creates no run', async () => {
    expect((await deck('u-sana', DM, '--from recording:mock-rec-town-hall-1')).status).toBe(404);
    expect((await deck('u-mira', DM, `--from recording:${REC}`)).status).toBe(403);
    expect((await deck('u-sana', 'social:dm:u-mira:u-sana', `--from recording:${REC}`)).status).toBe(404);
    expect((await deck('u-sana', DM, '--from transcript')).status).toBe(400);
    expect(flowRunsFixture.rows()).toHaveLength(0);
  });
});
