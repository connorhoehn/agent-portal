// Reads the rows the social work graph draws, through the SAME providers and stores the /api/social and
// /api/chat routes use, and only the parts the viewer's gates admit (lib/work-graph/authority.ts
// socialWorkGraphViewer). docs/activity-graph-migration.md §10.
//
// Membership is the spine. A conversation is read ONLY after the viewer is shown to belong to it NOW, by the
// authority the chat itself asks (lib/gateway/authority.ts admitSocialConversation: the name's lobby rule —
// channel members, DM ids, team roster — and the chat service's explicit membership rows, no settled cache).
// Everything else (a thread, a call, a recording, a deck, a flow run) is drawn only when it attaches to one of
// those conversations. A private channel the viewer is not in is never read at all: not its title, its
// messages, its calls or its decks. Message text is never carried, only counts and the people who posted.

import { clock } from '../../mock/core/index.js';
import { listUsers } from '../../providers/identity.js';
import { listChannels } from '../../providers/social-channels.js';
import { listCalls, listRecordings, listRooms, listTeams } from '../../providers/social-platform.js';
import { socialDeckStore } from '../../providers/social-decks.js';
import { flowRunStore } from '../flow-runs/index.js';
import { sessionGatewayContext, type LiveGatewayAuth } from '../live-principal.js';
import { channelForSlug, socialChat } from '../social-chat.js';
import type { Session } from '../session.js';
import { firstLine } from '../upstream.js';
import type { SourceHealth } from './sources.js';
import type { FlowRunGraphRow } from './projection.js';
import { observedCalls, SOCIAL_CONVERSATION } from './social-events.js';
import type {
  SCallRow, SConversationRow, SDeckRow, SRecordingRow, SThreadRow, STeamRow, SocialViewerReads,
} from './social-projection.js';
import type { SocialWorkGraphSubject } from './snapshot.js';

export const SOCIAL_FLOW_KINDS = ['social.summarize', 'social.diagram', 'social.doc', 'social.agent', 'social.deck'] as const;
export const SOCIAL_FLOW_READ_CAP = 50;
const CONVERSATION_CAP = 200;
const THREAD_READ_CAP = 60;
const MESSAGES_PER_THREAD = 200;
const DECKS_PER_CONVERSATION = 20;
/** How long the call log may trail the call state store before an open row without a live call behind it is doubted. */
const CALL_LOG_LAG_MS = 5 * 60_000;

export interface SocialWorkGraphRows {
  conversations: SConversationRow[];
  teams: STeamRow[];
  threads: SThreadRow[];
  calls: SCallRow[];
  recordings: SRecordingRow[];
  decks: SDeckRow[];
  flowRuns: FlowRunGraphRow[];
  sources: SourceHealth[];
  complete: boolean;
}

function flowRow(run: import('../flow-runs/index.js').FlowRunRow): FlowRunGraphRow {
  return {
    id: run.id, kind: run.kind, scope: run.scope, status: run.status, steps: run.progress.map(step => ({ status: step.status })),
    createdAt: run.createdAt, updatedAt: run.updatedAt, finishedAt: run.finishedAt, leaseExpiresAt: run.leaseExpiresAt,
  };
}

/** `social:team:<team>:<channel>` — the chat name of a team's channel (portal socialPlatform.ts teamChannelName). */
export function teamChannelConversation(teamSlug: string, channelSlug: string): string {
  const bare = channelSlug.startsWith(`${teamSlug}-`) ? channelSlug.slice(teamSlug.length + 1) : channelSlug;
  return `social:team:${teamSlug}:${bare || channelSlug}`;
}

/** Group fan-out so a large directory cannot open hundreds of reads at once. */
async function inChunks<T, R>(items: readonly T[], size: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...await Promise.all(items.slice(i, i + size).map(work)));
  return out;
}

/** The conversations this viewer belongs to, each proven readable now. Never reads a conversation the viewer is not in. */
export async function loadViewerConversations(session: Session, names: Map<string, string>, problems: string[]): Promise<{ conversations: SConversationRow[]; teams: STeamRow[]; complete: boolean }> {
  const userId = session.sub;
  const chat = socialChat();
  await chat.ready;
  const { admitSocialConversation } = await import('../gateway/authority.js');
  const auth = sessionGatewayContext(session) as LiveGatewayAuth;
  const readable = (channel: string) => admitSocialConversation(userId, channel, auth);
  const conversations: SConversationRow[] = [];
  const teams: STeamRow[] = [];
  let complete = true;

  // Channels: the directory, filtered to the ones the viewer is an ACTIVE member of (a public channel they have not
  // joined is not theirs to see here — the chat gateway admits members only).
  try {
    const directory = (await listChannels()).slice(0, CONVERSATION_CAP);
    if (directory.length >= CONVERSATION_CAP) complete = false;
    await Promise.all(directory.map(row => chat.membershipStore.hydrate(channelForSlug(row.slug))));
    for (const row of directory) {
      const channel = channelForSlug(row.slug);
      if (!chat.membershipStore.isActiveMember(channel, userId) || !await readable(channel)) continue;
      conversations.push({ id: channel, kind: 'channel', title: `#${row.slug}`, private: row.privacy === 'private', teamId: null, updatedAt: row.createdAt, people: [] });
    }
  } catch (err) { problems.push(`channels: ${firstLine(err)}`); }

  // Direct messages: the viewer's own index; each re-proven.
  try {
    const { socialDirectMessages } = await import('../../routes/social.js');
    for (const dm of await socialDirectMessages(userId, names, CONVERSATION_CAP)) {
      if (!await readable(dm.channel)) continue;
      const title = dm.peers.length ? dm.peers.map(p => p.displayName).join(', ') : 'Direct message';
      conversations.push({ id: dm.channel, kind: 'dm', title: dm.peers.length > 1 ? `Group · ${title}` : title, private: true, teamId: null, updatedAt: dm.lastMessageAt,
        people: dm.peers.map(p => ({ id: p.userId, name: p.displayName })) });
    }
  } catch (err) { problems.push(`direct messages: ${firstLine(err)}`); }

  // Teams the viewer belongs to, and their channels they may read.
  try {
    for (const team of await listTeams(session)) {
      if (!team.role) continue;
      teams.push({ id: team.teamId, name: team.name, updatedAt: team.updatedAt, role: team.role });
      for (const c of team.channels) {
        const channel = teamChannelConversation(team.slug, c.slug);
        if (!SOCIAL_CONVERSATION.test(channel) || !await readable(channel)) continue;
        conversations.push({ id: channel, kind: 'team-channel', title: `${team.name} / ${c.name}`, private: c.channelPrivacy === 'private', teamId: team.teamId, updatedAt: team.updatedAt, people: [] });
      }
    }
  } catch (err) { problems.push(`teams: ${firstLine(err)}`); }

  // Rooms the platform shows this viewer (its own visibility rule).
  try {
    for (const room of await listRooms(session)) {
      const id = room.lobbyName;
      if (!SOCIAL_CONVERSATION.test(id)) continue;
      conversations.push({ id, kind: 'room', title: room.name, private: room.visibility === 'private', teamId: null, updatedAt: room.lastActiveAt, people: [] });
    }
  } catch (err) { problems.push(`rooms: ${firstLine(err)}`); }

  return { conversations, teams, complete };
}

/** The day's messages in each conversation: counts and posters only, within the viewer's history floor, deleted ones skipped. */
async function loadThreads(session: Session, conversations: SConversationRow[], window: { start: string; end: string }, names: Map<string, string>, problems: string[]): Promise<{ threads: SThreadRow[]; capped: boolean }> {
  const chat = socialChat();
  const candidates = conversations.filter(c => c.kind !== 'room')
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.id.localeCompare(b.id));
  const read = candidates.slice(0, THREAD_READ_CAP);
  const results = await inChunks(read, 8, async (conv): Promise<SThreadRow | null> => {
    try {
      const [messages, member] = await Promise.all([chat.chatStore.listMessages(conv.id, MESSAGES_PER_THREAD), chat.membershipStore.getMember(conv.id, session.sub)]);
      const floor = member?.historyFrom ?? null;
      const mine = messages.filter(m => !m.deletedAt && m.timestamp >= window.start && m.timestamp < window.end && (!floor || m.timestamp >= floor))
        .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      if (mine.length === 0) return null;
      const people = new Map<string, string>();
      for (const m of mine) {
        if (!m.userId) continue;
        const meta = m.metadata?.['displayName'];
        people.set(m.userId, typeof meta === 'string' && meta ? meta : names.get(m.userId) ?? m.userId);
      }
      return {
        conversationId: conv.id, count: mine.length, firstAt: mine[0]!.timestamp, lastAt: mine[mine.length - 1]!.timestamp,
        people: [...people].map(([id, name]) => ({ id, name })),
      };
    } catch (err) { problems.push(`messages: ${firstLine(err)}`); return null; }
  });
  return { threads: results.filter((t): t is SThreadRow => !!t), capped: candidates.length > read.length };
}

/** Null when the subject (a conversation) is not one the viewer belongs to (the route answers the uniform 404). */
export async function loadSocialWorkGraphRows(
  subject: SocialWorkGraphSubject, reads: SocialViewerReads, window: { start: string; end: string }, session: Session,
): Promise<SocialWorkGraphRows | null> {
  const empty: SocialWorkGraphRows = { conversations: [], teams: [], threads: [], calls: [], recordings: [], decks: [], flowRuns: [], sources: [], complete: true };
  if (!reads.view) return subject.kind === 'conversation' ? null : empty;
  const problems: string[] = [];
  const meetingProblems: string[] = [];
  const documentProblems: string[] = [];
  let complete = true;

  let names = new Map<string, string>();
  try { names = new Map((await listUsers()).map(u => [u.id, u.displayName])); } catch (err) { problems.push(`people: ${firstLine(err)}`); }

  const all = await loadViewerConversations(session, names, problems);
  if (!all.complete) complete = false;
  const focus = subject.kind === 'conversation' ? subject.id : null;
  const focusRow = focus ? all.conversations.find(c => c.id === focus) ?? null : null;
  if (focus && !focusRow) return null;
  // A conversation page is given only its own conversation (and its team): nothing else of the viewer's is read or drawn.
  const conversations = focusRow ? [focusRow] : all.conversations;
  const teams = focusRow ? all.teams.filter(t => t.id === focusRow.teamId) : all.teams;
  const known = new Set(conversations.map(c => c.id));

  const threadRead = await loadThreads(session, conversations, window, names, problems);
  if (threadRead.capped) complete = false;

  // Calls: the viewer's own log rows plus what the call state store says is live now, only in conversations they read.
  const calls = new Map<string, SCallRow>();
  const person = (id: string) => ({ id, name: names.get(id) ?? id });
  try {
    const liveNow = new Set(observedCalls().filter(c => !c.endedAt && !c.emptiedAt).map(c => c.callId));
    const now = Date.parse(clock.nowIso());
    for (const row of await listCalls(session)) {
      if (!known.has(row.lobbyName)) continue;
      // The platform's call log can keep a row open forever (a call that ended without telling it). Open means open only
      // when the call state store confirms it, or the row is too fresh for the log to have lagged; otherwise it is unknown.
      const openInLog = !row.endedAt && (row.outcome === 'ringing' || row.outcome === 'answered');
      const confirmed = liveNow.has(row.callId) || now - Date.parse(row.startedAt) <= CALL_LOG_LAG_MS;
      const outcome = openInLog && !confirmed ? 'unconfirmed' : row.outcome;
      calls.set(row.callId, {
        id: row.callId, conversationId: row.lobbyName, direction: row.direction, outcome, audioOnly: row.audioOnly,
        startedAt: row.startedAt, endedAt: row.endedAt ?? null, durationMs: row.durationMs ?? null,
        people: [...new Set([row.callerId, ...row.targetUserIds])].map(person),
      });
    }
  } catch (err) { meetingProblems.push(`call log: ${firstLine(err)}`); }
  for (const call of observedCalls()) {
    if (!known.has(call.lobbyName)) continue;
    const prior = calls.get(call.callId);
    // A call nobody is connected to is over for the graph even while the library holds it open for a rejoin: the
    // moment the last seat left is its end, and a rejoin brings it back (observeCall clears it).
    const endedAt = call.endedAt ?? call.emptiedAt;
    const live = !endedAt;
    // The state store knows a call is ringing or running now; the log carries its finished rows.
    if (prior && !live) continue;
    calls.set(call.callId, {
      id: call.callId, conversationId: call.lobbyName, direction: prior?.direction ?? 'live',
      outcome: live ? (call.answered ? 'live' : 'ringing') : 'ended', audioOnly: prior?.audioOnly ?? false,
      startedAt: prior?.startedAt ?? call.startedAt, endedAt, durationMs: prior?.durationMs ?? null,
      people: [...new Set([call.callerId, ...call.targetUserIds])].map(person),
    });
  }

  const recordings: SRecordingRow[] = [];
  try {
    for (const rec of await listRecordings(session)) {
      if (!known.has(rec.lobbyName)) continue;
      recordings.push({
        id: rec.recordingId, callId: rec.callId, conversationId: rec.lobbyName, startedAt: rec.startedAt, endedAt: rec.endedAt, durationMs: rec.durationMs,
        stage: rec.stage, people: rec.participants.map(p => ({ id: p.userId, name: p.displayName ?? names.get(p.userId) ?? p.userId })),
      });
    }
  } catch (err) { meetingProblems.push(`recordings: ${firstLine(err)}`); }

  // Decks built from a conversation the viewer reads (the REST read: owner, or a current member of the source conversation).
  const decks: SDeckRow[] = [];
  const deckConversations = conversations.filter(c => c.kind !== 'room');
  const deckReads = await inChunks(deckConversations, 8, async (conv) => {
    try { return (await socialDeckStore.listDecks(conv.id)).slice(0, DECKS_PER_CONVERSATION); } catch (err) { documentProblems.push(`decks: ${firstLine(err)}`); return []; }
  });
  deckReads.forEach((rows, i) => {
    for (const d of rows) decks.push({ id: d.id, conversationId: deckConversations[i]!.id, title: d.title, updatedAt: d.updatedAt, ownerName: names.get(d.createdBy) ?? null });
  });

  // The viewer's OWN flow runs (requester-private), in conversations they still read.
  let flowRuns: FlowRunGraphRow[] = [];
  try {
    const own = await flowRunStore.listByRequester('social', session.sub, SOCIAL_FLOW_KINDS, window.start, SOCIAL_FLOW_READ_CAP);
    if (own.length >= SOCIAL_FLOW_READ_CAP) complete = false;
    flowRuns = own.filter(run => known.has(run.scope)).map(flowRow);
  } catch (err) { problems.push(`flow runs: ${firstLine(err)}`); }

  const sources: SourceHealth[] = [
    { source: 'conversation', health: problems.length ? 'delayed' : 'available', ...(problems.length ? { message: problems.join('; ') } : {}) },
    { source: 'meeting', health: meetingProblems.length ? 'delayed' : 'available', ...(meetingProblems.length ? { message: meetingProblems.join('; ') } : {}) },
    { source: 'document', health: documentProblems.length ? 'delayed' : 'available', ...(documentProblems.length ? { message: documentProblems.join('; ') } : {}) },
  ];
  return { conversations, teams, threads: threadRead.threads, calls: [...calls.values()], recordings, decks, flowRuns, sources, complete };
}
