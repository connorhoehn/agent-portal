// What the meeting pages read and how they show it (docs/meeting-assistant-design.md, package 5). The wire shapes mirror
// middleware/src/routes/meeting-assistant.ts (`GET /api/calls/:id/assistant/minutes`, `GET /api/meetings`).
// Pure functions only: the pages stay thin and these are unit tested.

export interface MeetingListRow {
  callId: string;
  callName: string;
  lobby: string;
  initiativeId: string | null;
  startedAt: number;
  endedAt: number;
  attendees: string[];
  summary: string;
  decisionCount: number;
  actionItemCount: number;
  /** Proposals from this meeting waiting on the viewer's answer; absent from an older server. */
  waitingOnYou?: number;
}

export interface MinutesActionItem { text: string; ownerUserId?: string; ownerName?: string; done?: boolean }
export interface MinutesPerson { userId: string; name: string }

/** A proposal as the minutes list it: its state and who consented or objected, by name only (docs/meeting-consent-design.md). */
export interface MinutesProposal { id: string; statement: string; state: string; outcome: 'decision' | 'tool'; consentedBy: string[]; objectedBy: string[] }

export interface MinutesView {
  callId: string;
  callName: string;
  lobby: string;
  initiativeId: string | null;
  startedAt: number;
  endedAt: number;
  invitedBy: string;
  invitedByName: string;
  attendees: MinutesPerson[];
  summary: string;
  decisions: string[];
  actionItems: MinutesActionItem[];
  topics: string[];
  lineCount: number;
  truncated: boolean;
  writer: 'scripted' | 'openai' | 'none';
  createdAt: number;
  youAreInviter: boolean;
  /** Absent from an older server. */
  proposals?: MinutesProposal[];
  /** When the retention sweep removes the meeting (epoch ms), from the server's retention. Absent from an older server. */
  keptUntil?: number;
  /** What Nova covered: its listening seconds, the rest of its time in the call, and how many people were not transcribed (a count). */
  coverage?: MinutesCoverage;
  /** No draft: whether an attendee may ask Nova to write the minutes again. */
  rewrite?: { writing: boolean; possible: boolean; attemptsLeft: number };
}

export interface MinutesCoverage { listenedSeconds: number; pausedSeconds: number; untranscribed: number }

export interface TranscriptLineView {
  seq: number;
  userId: string | null;
  speakerName: string;
  text: string;
  at: number;
  startMs?: number;
  endMs?: number;
}

/** One page of the Meetings list; older pages follow the server's `next` cursor (`before`). */
export const MEETINGS_PAGE = 50;
export const meetingsUrl = (before?: number | null): string => `/api/meetings?limit=${MEETINGS_PAGE}${before ? `&before=${before}` : ''}`;
export const MEETINGS_URL = meetingsUrl();
export const rewriteUrl = (callId: string): string => `/api/calls/${encodeURIComponent(callId)}/assistant/minutes/rewrite`;
export const minutesUrl = (callId: string): string => `/api/calls/${encodeURIComponent(callId)}/assistant/minutes`;
export const transcriptUrl = (callId: string, after: number, limit: number): string => `/api/calls/${encodeURIComponent(callId)}/assistant/transcript?after=${after}&limit=${limit}`;
export const proposalsUrl = (callId: string): string => `/api/calls/${encodeURIComponent(callId)}/assistant/proposals`;
export const meetingHref = (callId: string): string => `/iq/meetings/${encodeURIComponent(callId)}`;
export const TRANSCRIPT_PAGE = 100;

/** "12 min" or "1 h 5 min"; under a minute reads "under a minute". */
export function durationLabel(startedAt: number, endedAt: number): string {
  const minutes = Math.max(0, Math.round((endedAt - startedAt) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "13 Nov 2026, 12:00" in the viewer's zone. */
export function whenLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`;
}

/** The names of the people, "A, B and C"; long rosters stop at four with a count. */
export function peopleLabel(names: readonly string[]): string {
  if (names.length <= 4) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0] ?? '';
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/** The summary's first sentence, for a table cell. */
export function summaryLine(summary: string, max = 140): string {
  const flat = summary.replace(/\s+/g, ' ').trim();
  const first = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

/**
 * Transcript segments for the library's TranscriptPanel: speaker names come from the minutes' roster (the line only holds what
 * the source called the speaker, which can be an id), and a line with no media offsets is placed by its clock time.
 */
export function transcriptSegments(lines: readonly TranscriptLineView[], roster: readonly MinutesPerson[], startedAt: number) {
  return lines.map((l) => {
    const startMs = l.startMs ?? Math.max(0, l.at - startedAt);
    const label = (l.userId ? roster.find((p) => p.userId === l.userId)?.name : undefined) ?? l.speakerName;
    return { startMs, endMs: l.endMs ?? startMs + 1000, ...(l.userId ? { speakerId: l.userId } : {}), speakerLabel: label || 'Unknown', text: l.text };
  });
}

/** Does this person have a use for a "Create work item" button on this item: it is theirs, or nobody's, and not already done in the call. */
export function canCreateFor(item: MinutesActionItem, viewerUserId: string | null): boolean {
  return !item.done && (!item.ownerUserId || item.ownerUserId === viewerUserId);
}

/** The meeting page asks again while something can still change: an answer is possible, or a run is under way. */
export const proposalsLive = (states: readonly string[]): boolean => states.some((s) => s === 'open' || s === 'objected' || s === 'consented' || s === 'running');

/** The first page and the older pages loaded after it, once each, newest first (a refresh of the first page can overlap them). */
export function mergeMeetings(first: readonly MeetingListRow[], older: readonly MeetingListRow[]): MeetingListRow[] {
  const seen = new Set<string>(); const out: MeetingListRow[] = [];
  for (const row of [...first, ...older]) if (!seen.has(row.callId)) { seen.add(row.callId); out.push(row); }
  return out;
}

/** The Meetings row's pill: "1 waiting on you", or null when nothing waits on the viewer. */
export const waitingLabel = (n: number | undefined): string | null => (n && n > 0 ? `${n} waiting on you` : null);

/** "14 Dec 2026", in the viewer's zone. */
export const dayLabel = (ms: number): string => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** How long the meeting is kept and who can remove it sooner: "Kept until 14 Dec 2026. Vera Green can delete it sooner." */
export function keptLine(m: Pick<MinutesView, 'keptUntil' | 'invitedByName' | 'youAreInviter'>): string | null {
  if (!m.keptUntil) return null;
  return `Kept until ${dayLabel(m.keptUntil)}. ${m.youAreInviter ? 'You' : m.invitedByName || 'The person who invited Nova'} can delete it sooner.`;
}

/** What Nova covered, for the page's meta line: its listening time (not the meeting's length), its paused time, and a COUNT of people not transcribed. */
export function coverageItems(c: MinutesCoverage | undefined): string[] {
  if (!c) return [];
  const items = [`Nova listened for ${durationLabel(0, c.listenedSeconds * 1000)}`];
  if (c.pausedSeconds >= 60) items.push(`paused for ${durationLabel(0, c.pausedSeconds * 1000)}`);
  if (c.untranscribed > 0) items.push(c.untranscribed === 1 ? '1 person was not transcribed' : `${c.untranscribed} people were not transcribed`);
  return items;
}

/** The Decisions and Action items sections when no minutes were written: never "No … were recorded", which reads as "there were none". */
export const MINUTES_UNAVAILABLE = 'Not available because the minutes could not be written.';
export const minutesWritten = (m: Pick<MinutesView, 'writer'>): boolean => m.writer !== 'none';

/** The page for a meeting the viewer cannot read, by the server's answer: only someone who was in the call is told why it is gone. */
export function goneCopy(failure: { status: number | null; code: string | null } | null): { title: string; description: string; writing: boolean } {
  if (failure?.code === 'MEETING_DELETED') return { title: 'Meeting deleted', description: 'This meeting\'s record was deleted.', writing: false };
  if (failure?.code === 'MEETING_EXPIRED') return { title: 'Meeting removed', description: 'This meeting\'s record was removed after the retention period.', writing: false };
  if (failure?.code === 'MINUTES_WRITING') return { title: 'Nova is writing the minutes', description: 'They appear here when they are ready.', writing: true };
  return { title: 'Meeting not found', description: 'There is no meeting record here. It may have been deleted, removed after the retention period, or you were not in that call.', writing: false };
}
