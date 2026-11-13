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
}

export interface MinutesActionItem { text: string; ownerUserId?: string; ownerName?: string; done?: boolean }
export interface MinutesPerson { userId: string; name: string }

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
}

export interface TranscriptLineView {
  seq: number;
  userId: string | null;
  speakerName: string;
  text: string;
  at: number;
  startMs?: number;
  endMs?: number;
}

export const MEETINGS_URL = '/api/meetings?limit=100';
export const minutesUrl = (callId: string): string => `/api/calls/${encodeURIComponent(callId)}/assistant/minutes`;
export const transcriptUrl = (callId: string, after: number, limit: number): string => `/api/calls/${encodeURIComponent(callId)}/assistant/transcript?after=${after}&limit=${limit}`;
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
