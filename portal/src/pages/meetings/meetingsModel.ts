// What the meeting pages read and how they show it (docs/meeting-assistant-design.md, package 5). The wire shapes mirror
// middleware/src/routes/meeting-assistant.ts (`GET /api/calls/:id/assistant/minutes`, `GET /api/meetings`).
// Pure functions only: the pages stay thin and these are unit tested.

import { ASSISTANT_NAME } from '../../lib/meetingAssistantModel.ts';

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
  /** The summary's lead sentence (absent from an older server: read from `summary`). */
  summaryLead?: string;
  /** Milo's listening time in seconds; null when the server no longer knows it, absent from an older server. */
  listenedSeconds?: number | null;
  /** What came out of the meeting, counted by the server: decisions (agreed proposals included), action items, proposals still open. */
  outcomes?: { decisions: number; actionItems: number; open: number };
  /** The people with their portraits, in `attendees` order; absent from an older server. */
  people?: Array<{ name: string; avatarUrl: string | null }>;
}

/**
 * `workItemCreated`: the server says its work item exists (done in the call, its card was carried out, or it was made from the meeting
 * page); absent from an older server. `workItemHref`: the server's link to the one made from the meeting page, else null or absent.
 */
export interface MinutesActionItem { text: string; ownerUserId?: string; ownerName?: string; done?: boolean; workItemCreated?: boolean; workItemHref?: string | null }

/** The route that makes an action item's work item (the server creates it and records it once). */
export const createWorkItemUrl = (callId: string, index: number): string =>
  `/api/calls/${encodeURIComponent(callId)}/assistant/minutes/action-items/${index}/work-item`;

/** The server's link to an action item's work item, only when it is the portal's own work-item page; anything else is no link. */
export function workItemLink(i: MinutesActionItem): string | null {
  const href = i.workItemHref;
  return typeof href === 'string' && /^\/iq\/projects\/[^/?#]+\?tab=work&item=[^&#/]+$/.test(href) ? href : null;
}
/** `avatarUrl`: the person's portrait from the server; null or absent draws initials. */
export interface MinutesPerson { userId: string; name: string; avatarUrl?: string | null }

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
  /** Everyone who invited Milo into the call, in the order of their periods, once each. Absent from an older server (`invitedByName` alone). */
  inviters?: Array<{ userId: string; name: string }>;
  attendees: MinutesPerson[];
  summary: string;
  /** The summary split by the server: its lead sentence and up to four bullets. Absent from an older server (`summaryOf` reads `summary`). */
  summaryLead?: string;
  summaryPoints?: string[];
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
  /** What Milo covered: its listening seconds, the rest of its time in the call, and how many people were not transcribed (a count). */
  coverage?: MinutesCoverage;
  /**
   * No draft (or an addition that could not be written): whether an attendee may ask Milo to try again. `autoRetrying`: Milo will still
   * try again by itself (absent from an older server, read as true).
   */
  rewrite?: { writing: boolean; possible: boolean; attemptsLeft: number; autoRetrying?: boolean };
  /** Milo was invited back and is in the call now. Absent from an older server. */
  backInCall?: boolean;
  /** A later part of the call could not be added to these minutes yet. Absent from an older server. */
  additionOwed?: boolean;
  /** Milo has left again and the minutes do not cover that yet: the addition is due (read again until it lands). Absent from an older server. */
  additionDue?: boolean;
  /** How many times a later part of the call was added. Absent from an older server. */
  additions?: number;
}

/**
 * The one quiet sentence under the summary about a later part of the call: Milo is back in the call (what it hears is added when it
 * leaves), it is adding it now, or it could not yet. Null when there is nothing to say.
 */
export function additionNote(m: Pick<MinutesView, 'backInCall' | 'additionOwed' | 'additionDue' | 'rewrite'>): string | null {
  if (m.backInCall) return `${ASSISTANT_NAME} is back in this call. What it hears now is added to these minutes when it leaves.`;
  if (!m.additionOwed) return m.additionDue ? `${ASSISTANT_NAME} is adding the later part of this call to these minutes.` : null;
  if (m.rewrite?.writing) return `${ASSISTANT_NAME} is adding the later part of this call to these minutes.`;
  if (m.rewrite && m.rewrite.attemptsLeft === 0) return `${ASSISTANT_NAME} could not add the later part of this call to these minutes and will not try again. The transcript below has all of it.`;
  // "Will try again" only while the server's sweep still will; after that the page menu's retry is the way.
  return m.rewrite?.autoRetrying === false
    ? `${ASSISTANT_NAME} could not add the later part of this call to these minutes. These minutes cover the earlier part. You can ask ${ASSISTANT_NAME} to try again from the menu.`
    : `${ASSISTANT_NAME} could not add the later part of this call to these minutes yet. These minutes cover the earlier part, and ${ASSISTANT_NAME} will try again.`;
}

/** How long the meeting page keeps reading after Milo left again, waiting for the minutes to cover that leave. */
export const ADDITION_FOLLOW_MS = 5 * 60_000;

/** The page menu's retry, when one is possible: write failed minutes again, or add the later part again. Null when none. */
export function retryLabel(m: Pick<MinutesView, 'writer' | 'additionOwed' | 'rewrite'>, written: boolean): string | null {
  const r = m.rewrite;
  if (!r?.possible || r.writing || r.attemptsLeft <= 0) return null;
  if (m.additionOwed) return 'Add the later part again';
  return written ? null : 'Write the minutes again';
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

/** "12 min" or "1 h 5 min"; under a minute reads "less than a minute". */
export function durationLabel(startedAt: number, endedAt: number): string {
  const minutes = Math.max(0, Math.round((endedAt - startedAt) / 60_000));
  if (minutes < 1) return 'less than a minute';
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

/** The Decisions and Action items sections when no minutes were written: never "No … were recorded", which reads as "there were none". */
export const MINUTES_UNAVAILABLE = 'Not available because the minutes could not be written.';
export const minutesWritten = (m: Pick<MinutesView, 'writer'>): boolean => m.writer !== 'none';

/** The page for a meeting the viewer cannot read, by the server's answer: only someone who was in the call is told why it is gone. */
export function goneCopy(failure: { status: number | null; code: string | null } | null): { title: string; description: string; writing: boolean } {
  if (failure?.code === 'MEETING_DELETED') return { title: 'Meeting deleted', description: 'This meeting\'s record was deleted.', writing: false };
  if (failure?.code === 'MEETING_EXPIRED') return { title: 'Meeting removed', description: 'This meeting\'s record was removed after the retention period.', writing: false };
  if (failure?.code === 'MINUTES_WRITING') return { title: `${ASSISTANT_NAME} is writing the minutes`, description: 'They appear here when they are ready.', writing: true };
  return { title: 'Meeting not found', description: 'There is no meeting record here. It may have been deleted, removed after the retention period, or you were not in that call.', writing: false };
}

// ---- the redesigned meeting page and list (one meta line, "Needs you", outcome tables) -------------------------------------------

/**
 * The summary's lead and bullets: the server's split when it sends one, otherwise the stored text read the same way (a "- " line is a
 * bullet), so an older paragraph is all lead.
 */
export function summaryOf(m: Pick<MinutesView, 'summary' | 'summaryLead' | 'summaryPoints'>): { lead: string; points: string[] } {
  if (typeof m.summaryLead === 'string') return { lead: m.summaryLead, points: (m.summaryPoints ?? []).slice(0, 4) };
  const lines = m.summary.split('\n').map((l) => l.trim()).filter(Boolean);
  const points = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim()).filter(Boolean);
  const lead = lines.filter((l) => !l.startsWith('- ')).join(' ');
  return { lead: lead || points[0] || '', points: (lead ? points : points.slice(1)).slice(0, 4) };
}

/** The Meetings row's quiet second line: the summary's lead. */
export const listLead = (r: Pick<MeetingListRow, 'summary' | 'summaryLead'>): string => summaryLine(r.summaryLead ?? summaryOf({ summary: r.summary }).lead, 160);

/** "3 min" of Milo's listening; null when unknown. */
export const listenedLabel = (seconds: number | null | undefined): string | null =>
  (typeof seconds === 'number' ? durationLabel(0, seconds * 1000) : null);

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "2 decisions · 3 actions · 1 open", leaving out the zeros; "Nothing recorded" when all are zero; null from an older server. */
export function outcomesLabel(o: MeetingListRow['outcomes']): string | null {
  if (!o) return null;
  const parts = [
    ...(o.decisions ? [plural(o.decisions, 'decision', 'decisions')] : []),
    ...(o.actionItems ? [plural(o.actionItems, 'action', 'actions')] : []),
    ...(o.open ? [`${o.open} open`] : []),
  ];
  return parts.length ? parts.join(' · ') : 'Nothing recorded';
}

/** Everyone who invited Milo, in order (the server's list, else the one name an older server sends). */
const invitersOf = (m: Pick<MinutesView, 'invitedByName' | 'inviters'> & { invitedBy?: string }): Array<{ userId: string; name: string }> =>
  (m.inviters?.length ? m.inviters : m.invitedByName ? [{ userId: m.invitedBy ?? '', name: m.invitedByName }] : []);

/** The header's one meta line, as words (the people are drawn as avatars between them by the page): "invited by Vera Green, then Nora DaSilva". */
export function headerMeta(m: Pick<MinutesView, 'startedAt' | 'coverage' | 'invitedByName' | 'inviters'> & { invitedBy?: string }): { when: string; listened: string | null; invitedBy: string } {
  const listened = m.coverage ? `${ASSISTANT_NAME} listened for ${durationLabel(0, m.coverage.listenedSeconds * 1000)}` : null;
  const names = invitersOf(m).map((i) => i.name);
  return { when: whenLabel(m.startedAt), listened, invitedBy: `invited by ${names.length ? names.join(', then ') : m.invitedByName}` };
}

/**
 * The header's quieter second line: retention and who can delete sooner (every inviter, "You or Vera Green" for one of them; nobody
 * while Milo is back in the call, when nobody can), then Milo's pause and how many people were not transcribed.
 */
export function quietMeta(m: Pick<MinutesView, 'keptUntil' | 'invitedByName' | 'inviters' | 'youAreInviter' | 'coverage' | 'backInCall'> & { invitedBy?: string }, viewerUserId: string | null = null): string[] {
  const items: string[] = [];
  if (m.keptUntil) {
    items.push(`Kept until ${dayLabel(m.keptUntil)}`);
    if (!m.backInCall) {
      // An older server names one inviter: the viewer, when they are one.
      const listed = m.inviters?.length ? m.inviters : m.youAreInviter ? [] : invitersOf(m);
      const others = listed.filter((i) => !m.youAreInviter || i.userId !== viewerUserId).map((i) => i.name);
      const who = [...(m.youAreInviter ? ['You'] : []), ...others];
      items.push(`${who.length ? who.join(' or ') : `The person who invited ${ASSISTANT_NAME}`} can delete it sooner`);
    }
  }
  const c = m.coverage;
  if (c && c.pausedSeconds >= 60) items.push(`${ASSISTANT_NAME} paused for ${durationLabel(0, c.pausedSeconds * 1000)}`);
  if (c && c.untranscribed > 0) items.push(c.untranscribed === 1 ? '1 person was not transcribed' : `${c.untranscribed} people were not transcribed`);
  return items;
}

export type PillTone = 'info' | 'success' | 'warning' | 'error' | 'neutral' | 'pending';

/** A proposal's status pill, worded as the call's card words it. */
export function proposalPill(p: { state: string; source?: string; outcome?: { kind: string }; run?: { raisedAs: string | null } | null }): { label: string; tone: PillTone } {
  switch (p.state) {
    case 'open': return { label: 'Waiting for consent', tone: 'pending' };
    case 'consented': return { label: 'Consented', tone: 'info' };
    case 'running': return { label: 'Running', tone: 'info' };
    case 'done': return { label: 'Done', tone: 'success' };
    case 'failed': return { label: 'Failed', tone: 'error' };
    case 'objected': return { label: 'Objected', tone: 'warning' };
    case 'expired': return { label: 'Expired', tone: 'neutral' };
    case 'dismissed': return {
      label: p.run?.raisedAs ? 'Raised again' : p.source === 'asked' ? 'Dropped' : p.outcome?.kind === 'tool' ? 'Not needed' : 'Not a decision', tone: 'neutral',
    };
    default: return { label: p.state, tone: 'neutral' };
  }
}

/** Closed proposals (done, failed, not a decision, expired) are listed after the open ones and muted. */
export const proposalClosed = (state: string): boolean => state === 'done' || state === 'failed' || state === 'dismissed' || state === 'expired';

/** Open proposals first, then closed ones, each group in its own order (oldest first). */
export function orderProposals<P extends { state: string }>(list: readonly P[]): P[] {
  return [...list.filter((p) => !proposalClosed(p.state)), ...list.filter((p) => proposalClosed(p.state))];
}

/** An action item's status pill: done in the call, its work item made, or not yet. */
export function actionStatus(i: MinutesActionItem): { label: string; tone: PillTone } {
  if (i.done) return { label: 'Done in the call', tone: 'success' };
  if (i.workItemCreated) return { label: 'Work item created', tone: 'success' };
  return { label: 'Not created', tone: 'neutral' };
}

/** An action item waiting on the viewer: theirs (named as its owner), not done, and with no work item yet. */
export const actionWaitsOn = (i: MinutesActionItem, viewerUserId: string | null): boolean =>
  !!viewerUserId && i.ownerUserId === viewerUserId && !i.done && !i.workItemCreated;

/** One row of the Decisions table: a decision line of the minutes, or a decision people agreed through a proposal. */
export interface DecisionRow { key: string; text: string; initiativeId: string | null; agreedBy: string[]; href: string | null }

/**
 * The Decisions table: the minutes' own decision lines (on the meeting's initiative; nobody recorded as agreeing), then each decision
 * proposal everyone needed consented to, with who consented and, once recorded, the link to it. The same count as the minutes card.
 */
export function decisionRows(
  m: Pick<MinutesView, 'decisions' | 'initiativeId'>,
  proposals: ReadonlyArray<{ id: string; statement: string; state: string; outcome: { kind: string; initiativeId?: string | null }; responses: ReadonlyArray<{ name: string; response: string }>; run: { href: string | null } | null }>,
): DecisionRow[] {
  const own = m.decisions.map((text, i) => ({ key: `m${i}`, text, initiativeId: m.initiativeId, agreedBy: [], href: null }));
  const agreed = proposals.filter((p) => p.outcome.kind === 'decision' && (p.state === 'consented' || p.state === 'running' || p.state === 'done')).map((p) => ({
    key: `p${p.id}`, text: p.statement, initiativeId: p.outcome.initiativeId ?? m.initiativeId,
    agreedBy: p.responses.filter((r) => r.response === 'consent').map((r) => r.name), href: p.state === 'done' ? p.run?.href ?? null : null,
  }));
  return [...agreed, ...own];
}

/** A face for an avatar: the person's name and, when the server sent one, their portrait. */
export interface Face { name: string; src?: string }

/** Faces for a list of names, with the portraits the meeting's people carry (by name; a name without one draws initials). */
export function facesFor(names: readonly string[], people: ReadonlyArray<{ name: string; avatarUrl?: string | null }>): Face[] {
  const src = new Map(people.filter((p) => p.avatarUrl).map((p) => [p.name, p.avatarUrl as string]));
  return names.map((name) => (src.has(name) ? { name, src: src.get(name)! } : { name }));
}

const TOOL_DONE: Record<string, string> = {
  create: 'Created a record', update: 'Updated a record', message: 'Sent a message', search: 'Looked something up', comment: 'Added a comment',
};

/**
 * An action item's words for a person. Something done in the call is stored by the minutes service as "Created work item: X" or, when
 * it had no title, "Ran <tool>" (minutes-service.ts `doneActionText`); neither form reaches a person: "Created work item "X"", or a
 * plain sentence for the tool. Any other text is shown as written.
 */
export function actionText(text: string): string {
  const created = /^Created ([^:]+): (.+)$/.exec(text);
  if (created) return `Created ${created[1]!.replace(/^a /, '')} "${created[2]!}"`;
  const ran = /^Ran ([a-z_-]+)$/i.exec(text.trim());
  if (ran) return TOOL_DONE[ran[1]!.toLowerCase()] ?? `${ASSISTANT_NAME} carried out a request`;
  return text;
}

/**
 * The Proposals table's short "What it does": the kind and the target, "Decision · Observability Platform" or "Work item · Observability
 * Platform". The full sentence stays in the proposal's detail. `target` is the initiative's name, or null while unknown.
 */
export function outcomeShort(outcome: { kind: 'decision' | 'tool'; name?: string; summary?: string }, target: string | null): string {
  let kind = 'Decision';
  if (outcome.kind === 'tool') {
    const made = /^Create an? (.+?) titled\b/i.exec(outcome.summary ?? '');
    kind = made ? made[1]!.charAt(0).toUpperCase() + made[1]!.slice(1)
      : outcome.name === 'update' ? 'Update' : outcome.name === 'message' ? 'Message' : outcome.name === 'create' ? 'New record' : 'Action';
  }
  return target ? `${kind} · ${target}` : kind;
}
