// What happens when the assistant leaves (docs/meeting-assistant-design.md, package 5): write the minutes once, say so in
// the call chat, and offer each owned action item to its owner. Called from the runtime's `onFinished` (dismiss, the
// ceiling, a lost connection) and from the call-end signal (lib/call-chat.ts `onCallChatFinished`), so every way of
// leaving ends here; the first writer wins (`putMinutes` is idempotent on the call id) and a deleted record is never
// written again (the tombstone).
//
// Milo can be invited back into a call it left. When it leaves again the minutes are ADDED to, never written twice: the writer reads
// only the lines after `throughSeq` with the stored minutes as `earlier`, the store appends what is new after what is there (indices
// name items, so they never move) under a compare on `throughSeq`, and the bell rings once more. A leave that arrives while an earlier
// write of the same call still runs waits for it (one queue per call), so nothing a later period heard is lost.
//
// Privacy: minutes are the attendees' (routes/meeting-assistant.ts `attendeeOf`). Nothing here widens that.
//
// Proposals (docs/meeting-consent-design.md, package 6): a decision a proposal already holds is not written again as a decision line;
// the minutes route lists each proposal with its state and the names of who consented or objected, read live, so a consent given on
// the meeting page after the call shows there.
import { createHash } from 'node:crypto';
import { getProject } from '../../providers/projects.js';
import { hashToolArgs, voiceTool } from '../voice/catalogue.js';
import { delegationCostUsd, delegationModel } from '../voice/ledger.js';
import { voiceProviderConfigured } from '../voice/openai.js';
import { callChatRuntime } from '../call-chat.js';
import { notify } from '../social-notify.js';
import { nameOf, postAction, postAsAssistant, postNoticeQuietly, noticeText } from './chat.js';
import { ASSISTANT_NAME, type MinutesCounts } from './chat-types.js';
import { meetingTools } from './instructions.js';
import {
  additionSentence, capTranscript, chatSummary, minutesCounts, withoutHeld, withoutStored, withoutStoredItems, MINUTES_TIMEOUT_MS, MinutesWriterError, OpenAiMinutesWriter, ScriptedMinutesWriter, type MinutesDraft, type MinutesWriter, type RosterEntry,
} from './minutes.js';
import { assistantStore } from './store-select.js';
import { minutesSourceId, minutesSpend, SCRIPTED_MINUTES_USD } from './spend.js';
import { linesForModels, payerFields, policyCallOf, policyForLobby } from './policy.js';
import { mockTranscriptEnabled } from './transcript-source.js';
import { sessionOf, type AssistantRecord, type AssistantTurn, type MinutesRecord, type MinutesWriterKind, type TranscriptLine } from './types.js';

/** Where the meeting page lives in the portal (`/iq/meetings/:callId`); the chat message and the notification link to it. */
export const meetingPagePath = (callId: string): string => `/iq/meetings/${encodeURIComponent(callId)}`;

export type MinutesWriterFactory = () => MinutesWriter | null;

export const defaultMinutesWriterFactory: MinutesWriterFactory = () => {
  if (mockTranscriptEnabled()) return new ScriptedMinutesWriter();
  return voiceProviderConfigured() ? new OpenAiMinutesWriter() : null;
};
let writerFactory: MinutesWriterFactory | null = null;
export function setMinutesWriterFactory(next: MinutesWriterFactory | null): void { writerFactory = next; }

/**
 * Hard caps on writer runs per meeting: each run may cost model money. The sweep tries a failed write again until AUTO_ATTEMPTS runs
 * were made in all; an attendee's "Write the minutes again" is refused once MAX_ATTEMPTS were made. Enforced by the store's conditional
 * count (`claimMinutesAttempt`), so two presses, a press and the sweep, or two processes cannot exceed them.
 */
export const AUTO_ATTEMPTS = 3;
export const MAX_ATTEMPTS = 5;

const NOTES = {
  budget: `${ASSISTANT_NAME} could not write the minutes because the inviter's budget did not allow it. The transcript is kept; the people who were in the call can read it.`,
  failed: `${ASSISTANT_NAME} could not write the minutes. The transcript is kept; the people who were in the call can read it.`,
  noWriter: 'Minutes are not available in this deployment. The transcript is kept; the people who were in the call can read it.',
  onPage: 'The minutes are on the meeting page.',
} as const;

/** Writes in flight, so a test (and a shutdown) can wait for them. */
const inFlight = new Set<Promise<unknown>>();
export async function minutesIdle(): Promise<void> { while (inFlight.size) await Promise.allSettled([...inFlight]); }
export function trackMinutes<T>(p: Promise<T>): Promise<T> { return track(p); }
function track<T>(p: Promise<T>): Promise<T> { inFlight.add(p); const done = () => { inFlight.delete(p); }; p.then(done, done); return p; }

async function allLines(callId: string): Promise<TranscriptLine[]> {
  const store = assistantStore();
  const out: TranscriptLine[] = [];
  for (let after = 0; ;) {
    const page = await store.lines(callId, after, 500);
    if (!page.length) return out;
    out.push(...page); after = page[page.length - 1]!.seq;
    if (out.length > 200_000) return out;
  }
}

/** "14 Nov", in UTC (the server has no viewer's zone; the page shows the exact time beside it). */
const dayLabel = (ms: number): string => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * A call with no initiative is named by its people and day, "Call with Ana and Raj, 14 Nov", so the Meetings list is not a column of
 * identical "Call" rows. First names only; a long roster stops at two names and a count.
 */
export function untitledCallName(names: readonly string[], endedAt: number): string {
  const first = [...new Set(names.map((n) => n.trim().split(/\s+/)[0] ?? '').filter(Boolean))];
  const who = first.length === 0 ? '' : first.length === 1 ? first[0]! : first.length <= 3
    ? `${first.slice(0, -1).join(', ')} and ${first[first.length - 1]}` : `${first.slice(0, 2).join(', ')} and ${first.length - 2} others`;
  return who ? `Call with ${who}, ${dayLabel(endedAt)}` : `Call on ${dayLabel(endedAt)}`;
}

/** The name a meeting is shown under: the stored one, or for a meeting stored before untitled calls were named, its people and day. */
export function meetingNameOf(m: Pick<MinutesRecord, 'callName' | 'endedAt'>, attendeeNames: readonly string[]): string {
  return m.callName && m.callName !== 'Call' ? m.callName : untitledCallName(attendeeNames, m.endedAt);
}

/** The call's name for the minutes: the initiative's name when it has one, else its people and day. */
async function callNameOf(record: AssistantRecord, roster: readonly RosterEntry[], endedAt: number): Promise<string> {
  const untitled = () => untitledCallName(roster.map((r) => r.name), endedAt);
  if (!record.initiativeId) return untitled();
  try { const name = (await getProject(record.initiativeId))?.name; return name ? `${name} call` : untitled(); } catch { return untitled(); }
}

export const MINUTES_READY_TYPE = 'meeting-minutes-ready';

/**
 * The bell for written minutes: one notification per attendee, "Minutes are ready: <call>", linking to the meeting page. It carries
 * no content of the meeting (the notification service cannot delete, and the inviter's delete must leave nothing behind). Sent once per
 * meeting: the store marks it before sending, so a restart or a second writer never rings it again. Never throws.
 */
export async function notifyMinutesReady(minutes: MinutesRecord, now: number = Date.now()): Promise<string[]> {
  try {
    if (minutes.deleted || minutes.writer === 'none' || !minutes.attendees.length) return [];
    if (!(await assistantStore().claimMinutesNotice(minutes.callId, now))) return [];
    const names = await Promise.all(minutes.attendees.map((u) => nameOf(u)));
    const name = meetingNameOf(minutes, names);
    const policy = policyForLobby(minutes.lobby); const call = policyCallOf(minutes); // the bell reaches whom the call's policy lets it
    return await notify(minutes.attendees.filter((u) => policy.rings(call, u)), {
      // Once per writing: an addition (Milo was invited back and heard more) clears the claim, and its bell says the minutes changed.
      // The meeting's name after a colon, as the page titles it: "Minutes are ready: Observability Platform call".
      type: MINUTES_READY_TYPE, title: (minutes.additions ?? 0) > 0 ? `Minutes were updated: ${name}` : `Minutes are ready: ${name}`,
      action: { label: 'Open the meeting', href: meetingPagePath(minutes.callId) },
      payload: { tenant: minutes.tenant, kind: MINUTES_READY_TYPE, callId: minutes.callId },
    });
  } catch (e) { console.warn('[meeting-assistant] minutes notice not sent', (e as Error).message); return []; }
}

/** Is the call still running with this person seated? (A card needs the owner's browser in the call.) */
async function seatedNow(callId: string): Promise<Set<string>> {
  try {
    if (!(await callChatRuntime().lobbyOf(callId))) return new Set();
    return new Set((await callChatRuntime().seatedUsers(callId)).filter((u) => u.active).map((u) => u.userId));
  } catch { return new Set(); }
}

/** The "create" call's arguments for a work item, with every field the strict schema names present (null when unused). */
export function createWorkItemArgs(title: string, initiativeName: string | null): { kind: string; fields: Record<string, string | null> } {
  const fieldsSchema = ((voiceTool('create')?.parameters as { properties?: { fields?: { properties?: Record<string, unknown> } } } | undefined)?.properties?.fields?.properties) ?? {};
  const fields: Record<string, string | null> = Object.fromEntries(Object.keys(fieldsSchema).map((k) => [k, null]));
  fields['title'] = title.slice(0, 200);
  if (initiativeName) fields['initiative'] = initiativeName.slice(0, 200);
  return { kind: 'work-item', fields };
}

const WRITE_CARD_TTL_MS = 10 * 60_000;
const MAX_CARDS = 8;


/**
 * One writer run, its cost held and booked under the run's own source id (`minutesSourceId`): `run.addition` is 0 for the first write and
 * then the number of the addition, `run.attempt` which run of it this is. The ledger books once per id, so a retry or an addition booked
 * under the first write's id would be lost.
 */
async function writeDraft(record: AssistantRecord, writer: MinutesWriter, input: Parameters<MinutesWriter['write']>[0], run: { addition: number; attempt: number }): Promise<{ draft: MinutesDraft | null; note: string | null; writer: MinutesWriterKind }> {
  const spend = minutesSpend();
  const common = { callId: record.callId, sourceId: minutesSourceId(record.callId, run.addition, run.attempt), tenant: record.tenant, ...payerFields(record) };
  if (writer.kind === 'scripted') {
    const draft = await writer.write(input);
    await spend.record({ ...common, model: 'scripted-minutes', costUsd: SCRIPTED_MINUTES_USD, basis: 'estimated' }).catch((e: unknown) => console.warn('[meeting-assistant] minutes spend not booked', (e as Error).message));
    return { draft, note: null, writer: 'scripted' };
  }
  const model = delegationModel();
  const capped = capTranscript(input.lines, input.roster);
  const bytes = capped.lines.reduce((n, l) => n + l.text.length + 24, 0);
  const estimate = await delegationCostUsd(model, { inputTokens: Math.ceil(bytes / 4) + 400, outputTokens: 2000, cachedTokens: 0, responses: 1 }).catch(() => null);
  const estimateUsd = Math.round((estimate ?? 0.05) * 1.5 * 10_000) / 10_000;
  const held = await spend.reserve({ ...common, estimateUsd });
  if (!held.ok) return { draft: null, note: NOTES.budget, writer: 'none' };
  try {
    const draft = await writer.write(input);
    const usage = draft.usage;
    const cost = usage ? await delegationCostUsd(model, { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedTokens: Math.min(usage.cachedTokens, usage.inputTokens), responses: 1 }).catch(() => null) : null;
    await spend.record({
      ...common, model, costUsd: cost ?? estimate, basis: cost != null ? 'reported' : estimate != null ? 'estimated' : 'unknown',
      ...(usage ? { tokensIn: usage.inputTokens, tokensOut: usage.outputTokens } : {}),
    }).catch((e: unknown) => console.warn('[meeting-assistant] minutes spend not booked', (e as Error).message));
    return { draft, note: null, writer: 'openai' };
  } catch (e) {
    console.warn('[meeting-assistant] minutes writer failed', (e as Error).message);
    // A failure after the request went out still cost something: book the reported usage, or an estimate. Before that, nothing.
    if (e instanceof MinutesWriterError && e.requestSent) {
      const u = e.usage;
      const cost = u ? await delegationCostUsd(model, { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cachedTokens: Math.min(u.cachedTokens, u.inputTokens), responses: 1 }).catch(() => null) : null;
      await spend.record({
        ...common, model, costUsd: cost ?? estimate, basis: cost != null ? 'reported' : estimate != null ? 'estimated' : 'unknown',
        ...(u ? { tokensIn: u.inputTokens, tokensOut: u.outputTokens } : {}),
      }).catch((err: unknown) => console.warn('[meeting-assistant] minutes spend not booked', (err as Error).message));
    }
    await spend.release(held.holdId ? [held.holdId] : []);
    return { draft: null, note: NOTES.failed, writer: 'none' };
  }
}

const actionCardKey = (callId: string, index: number): string => createHash('sha256').update(`${callId}:${index}`).digest('hex').slice(0, 16);
/** The turn behind the "Create a work item" card offered for the minutes' action item at `index`; once done, the work item exists. */
export const actionCardTurnId = (callId: string, index: number): string => `t-m-${actionCardKey(callId, index)}`;

/** Offer each owned action item to its owner as a "Create a work item" card, only while the owner is still in the live call. */
async function offerCards(record: AssistantRecord, minutes: MinutesRecord, initiativeName: string | null, fromIndex = 0): Promise<number> {
  const store = assistantStore();
  const seated = await seatedNow(record.callId);
  if (!seated.size) return 0;
  let cards = 0;
  for (const [i, item] of minutes.actionItems.entries()) {
    if (cards >= MAX_CARDS) break;
    if (i < fromIndex) continue; // an addition offers only its new items; the earlier ones were offered when they were written
    const owner = item.ownerUserId;
    if (item.done || !owner || !seated.has(owner) || !minutes.attendees.includes(owner)) continue;
    const roles = await import('./orchestrator.js').then((m) => m.defaultRolesOf(owner, record.tenant)).catch(() => [] as string[]);
    if (!roles.some((role) => meetingTools(record.tenant, role).some((t) => t.name === 'create'))) continue;
    const args = createWorkItemArgs(item.text, initiativeName);
    const key = actionCardKey(record.callId, i);
    const actionId = `m-${key}`;
    const now = Date.now();
    const turn: AssistantTurn = { turnId: actionCardTurnId(record.callId, i), callId: record.callId, askedBy: owner, tool: { name: 'create', args }, kind: 'write', status: 'pending', actionId, createdAt: now, expiresAt: now + WRITE_CARD_TTL_MS };
    const made = await store.createTurn(turn);
    if (!made.created) continue;
    const posted = await postAction(record.callId, {
      actionId, askedBy: owner, askedByName: item.ownerName ?? await nameOf(owner), summary: `Create a work item: ${item.text}`,
      title: item.text.slice(0, 120), does: initiativeName ? `Creates a work item in ${initiativeName}` : 'Creates a work item',
      detail: [`title: ${item.text.slice(0, 120)}`], tool: { name: 'create', argsDigest: hashToolArgs(args) },
    }, { minutes: true }).catch(() => null);
    if (!posted) { await store.moveTurn(record.callId, turn.turnId, { from: ['pending'], to: 'expired' }); continue; }
    cards += 1;
  }
  return cards;
}

/**
 * Write the minutes for a call whose assistant has left, once. Returns the stored minutes, or null when there is nothing to
 * write (no assistant, still in the call, no lines recorded, or the record was deleted).
 */
export function writeMinutes(callId: string): Promise<MinutesRecord | null> {
  // One queue per call: a leave that arrives while an earlier write (or rewrite) still runs waits for it and then runs, so what Milo heard
  // after being invited back is added rather than lost. Requests that arrive while one is already waiting share that one.
  const waiting = queued.get(callId);
  if (waiting) return waiting;
  const running = writing.get(callId);
  if (!running) return startWrite(callId, () => writeMinutesOnce(callId));
  const next = running.then(() => undefined, () => undefined).then(() => { queued.delete(callId); return startWrite(callId, () => writeMinutesOnce(callId)); });
  queued.set(callId, next);
  return next;
}
const writing = new Map<string, Promise<MinutesRecord | null>>();
const queued = new Map<string, Promise<MinutesRecord | null>>();
/** Run one write as this call's current one (`writing`), and clear it when it ends unless a later one has taken its place. */
function startWrite(callId: string, run: () => Promise<MinutesRecord | null>): Promise<MinutesRecord | null> {
  const p: Promise<MinutesRecord | null> = run().finally(() => { if (writing.get(callId) === p) writing.delete(callId); });
  writing.set(callId, p);
  return p;
}

/** A write or a rewrite of this call's minutes is running in this process (the meeting page shows "Milo is writing the minutes"). */
export const minutesWriting = (callId: string): boolean => writing.has(callId);

interface Composed { minutes: MinutesRecord; draft: MinutesDraft | null; proposals: Awaited<ReturnType<ReturnType<typeof assistantStore>['listProposals']>>; initiativeName: string | null }

/** Run the writer over the call's transcript and shape the minutes; `attempts` is the run this is. Null when nothing was recorded. */
async function composeMinutes(callId: string, record: AssistantRecord, attempts: number, createdAt: number): Promise<Composed | null> {
  const store = assistantStore();
  // Only the lines the call's policy lets Milo's models read (an interview candidate who declined Milo: none of theirs).
  const lines = await linesForModels(record, await allLines(callId));
  if (!lines.length) return null;
  const attendees = [...new Set([...record.attendees, ...lines.flatMap((l) => (l.userId ? [l.userId] : []))])];
  const roster: RosterEntry[] = await Promise.all(attendees.map(async (userId) => ({ userId, name: await nameOf(userId) })));
  const endedAt = record.leftAt ?? Date.now();
  const callName = await callNameOf(record, roster, endedAt);
  const initiativeName = record.initiativeId ? await getProject(record.initiativeId).then((p) => p?.name ?? null).catch(() => null) : null;
  const turns = await store.listTurns(callId, { statuses: ['done'] }).catch(() => [] as AssistantTurn[]);
  const doneActions = turns.filter((t) => t.kind === 'write').map((t) => ({ text: doneActionText(t), ownerUserId: t.askedBy }));
  // The decisions the call's proposals already hold are listed as proposals (GET minutes), never invented again as decision lines.
  // A dismissed one ("Not a decision", or raised again as a new one) holds nothing: a real decision dismissed by mistake still
  // reaches the minutes as a decision line.
  const proposals = (await store.listProposals(callId).catch(() => [])).filter((p) => p.state !== 'dismissed');
  // What the proposals decided and what still waits for answers is not stored in the summary: the minutes route builds those bullets
  // from the proposals as they stand when the page asks (`summaryWithProposals`), so an answer given afterwards never leaves them stale.
  const held = { statements: proposals.map((p) => p.statement), evidence: proposals.flatMap((p) => p.evidence) };

  const writer = (writerFactory ?? defaultMinutesWriterFactory)();
  let result: { draft: MinutesDraft | null; note: string | null; writer: MinutesWriterKind } = { draft: null, note: NOTES.noWriter, writer: 'none' };
  if (writer) {
    result = await Promise.race([
      writeDraft(record, writer, { lines, roster, callName, doneActions, held }, { addition: 0, attempt: attempts }),
      new Promise<typeof result>((resolve) => { const t = setTimeout(() => resolve({ draft: null, note: NOTES.failed, writer: 'none' }), MINUTES_TIMEOUT_MS * 2 + 5000); t.unref?.(); }),
    ]);
  }
  const draft = result.draft ? { ...result.draft, decisions: withoutHeld(result.draft.decisions, held) } : null;
  const minutes: MinutesRecord = {
    callId, tenant: record.tenant, lobby: record.lobby, initiativeId: record.initiativeId, callName,
    startedAt: record.invitedAt, endedAt, invitedBy: record.invitedBy, attendees,
    summary: draft ? draft.summary : result.note ?? NOTES.failed, decisions: draft?.decisions ?? [], actionItems: draft?.actionItems ?? [], topics: draft?.topics ?? [],
    lineCount: lines.length, throughSeq: lines[lines.length - 1]!.seq, truncated: draft?.truncated ?? false, writer: result.writer, createdAt,
    // Without a writer there is nothing to try again; a failure or a refused budget may be tried again, within the caps.
    attempts: writer ? attempts : 0, retryable: !draft && !!writer, notifiedAt: null,
  };
  return { minutes, draft, proposals, initiativeName };
}

async function writeMinutesOnce(callId: string): Promise<MinutesRecord | null> {
  const store = assistantStore();
  const record = await store.get(callId);
  if (!record || record.state !== 'left') return null;
  const existing = await store.getMinutes(callId);
  if (existing) {
    // Milo was invited back and has left again. A deleted record is never written; minutes without a draft are written again over the
    // whole call (within the caps); minutes with a draft get what the later period heard added to them.
    if (existing.deleted) return null;
    // The same leave reported twice (the dismissal's run ending, then the call ending) finds minutes that already end at it: nothing to do.
    if ((record.leftAt ?? 0) <= existing.endedAt) return null;
    if (existing.writer === 'none') return existing.retryable ? rewriteRun(callId, record, existing, MAX_ATTEMPTS) : null;
    // An addition still owed (an earlier one failed) is the same addition, covering more lines now: this run counts as one more of its
    // runs, so it books under an id of its own rather than the earlier first run's.
    return addToMinutes(callId, record, existing, existing.additionOwed ? (existing.additionAttempts ?? 0) + 1 : 1, true);
  }
  const composed = await composeMinutes(callId, record, 1, Date.now());
  if (!composed) {
    // Nothing was recorded: no minutes. A person's dismissal already said so in its own notice; the other ways of leaving say it here.
    if (record.leftBy === 'system') await postNoticeQuietly(callId, noticeText.nothingRecorded, { minutes: true });
    return null;
  }
  const { minutes, draft, proposals, initiativeName } = composed;
  const stored = await store.putMinutes(minutes);
  if (!stored.created || stored.minutes.deleted) return null;

  // Written minutes post as a card: the text is the summary's first sentences and the counts ride on the message; the chat draws
  // the title, the counts and the link. Without a draft the note alone is the notice. Either way the page is a metadata field the
  // chat renders as a link; the text carries no path.
  // Proposals are read again: one consented while the writer ran is counted.
  const counts = draft ? minutesCounts(stored.minutes, await store.listProposals(callId).catch(() => proposals)) : null;
  const text = (draft ? chatSummary(stored.minutes.summary) : stored.minutes.summary).replace(/\s+/g, ' ').trim() || NOTES.onPage;
  await postAsAssistant(callId, { text, metadata: { assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-notice', meetingCallId: callId, ...(counts ? { minutes: counts } : {}) } }, { minutes: true })
    .catch((error: unknown) => console.warn('[meeting-assistant] notice not posted', (error as Error).message));
  // The call chat is closed to everyone once the call is over: the bell is how the attendees learn the minutes are there.
  if (draft) await notifyMinutesReady(stored.minutes);
  if (draft) await offerCards(record, stored.minutes, initiativeName).catch((e: unknown) => console.warn('[meeting-assistant] action cards not offered', (e as Error).message));
  return stored.minutes;
}

export type RewriteOutcome = 'started' | 'busy' | 'limit' | 'not-needed';

/**
 * Write the minutes again for a meeting whose earlier write produced no draft. `max` is the cap on writer runs in all: AUTO_ATTEMPTS
 * for the sweep, MAX_ATTEMPTS for an attendee's press. One run at a time per meeting (this process's `writing`, and the store's
 * conditional count across processes). Returns at once; the run itself is `done`.
 */
export async function rewriteMinutes(callId: string, max: number): Promise<{ outcome: RewriteOutcome; done: Promise<MinutesRecord | null> }> {
  const none = Promise.resolve(null);
  if (writing.has(callId)) return { outcome: 'busy', done: none };
  const store = assistantStore();
  const [record, current] = await Promise.all([store.get(callId), store.getMinutes(callId)]);
  if (!record || record.state !== 'left' || !current || current.deleted) return { outcome: 'not-needed', done: none };
  const cap = Math.min(max, MAX_ATTEMPTS);
  // An owed addition (a later period's could not be written) is tried again within the same caps, counted apart from the first write's.
  if (current.writer !== 'none') {
    if (!current.additionOwed) return { outcome: 'not-needed', done: none };
    const made = current.additionAttempts ?? 0;
    if (made >= cap) return { outcome: 'limit', done: none };
    if (writing.has(callId) || queued.has(callId)) return { outcome: 'busy', done: none };
    const run = startWrite(callId, async () => {
      if (!(await store.claimMinutesAddition(callId, made, cap))) return null;
      return addToMinutes(callId, record, current, made + 1, false);
    });
    return { outcome: 'started', done: track(run.catch((e: unknown) => { console.warn('[meeting-assistant] minutes addition failed', (e as Error).message); return null; })) };
  }
  if (!current.retryable) return { outcome: 'not-needed', done: none };
  const attempts = current.attempts ?? 1;
  if (attempts >= cap) return { outcome: 'limit', done: none };
  if (writing.has(callId) || queued.has(callId)) return { outcome: 'busy', done: none };
  const run = startWrite(callId, () => rewriteRun(callId, record, current, cap));
  return { outcome: 'started', done: track(run.catch((e: unknown) => { console.warn('[meeting-assistant] minutes rewrite failed', (e as Error).message); return null; })) };
}

/** One more run of the writer for minutes without a draft, over the whole call, claimed first (a crash after the claim still counts it). */
async function rewriteRun(callId: string, record: AssistantRecord, current: MinutesRecord, cap: number): Promise<MinutesRecord | null> {
  const store = assistantStore();
  const attempts = current.attempts ?? 1;
  if (attempts >= cap) return null;
  if (!(await store.claimMinutesAttempt(callId, attempts, cap))) return null;
  const composed = await composeMinutes(callId, record, attempts + 1, current.createdAt);
  if (!composed) return null;
  if (!(await store.rewriteMinutes(composed.minutes))) return null;
  const stored = await store.getMinutes(callId);
  if (stored && composed.draft) {
    // The chat last said the minutes could not be written: while the call still runs, it now gets the minutes card the first write
    // would have posted (after the call, the bell alone says it).
    if (await callRunning(callId)) {
      const counts = minutesCounts(stored, await store.listProposals(callId).catch(() => composed.proposals));
      await postMinutesCard(callId, chatSummary(stored.summary), counts);
    }
    await notifyMinutesReady(stored);
  }
  return stored;
}

/** Is the call still going (its chat open to the people in it)? */
async function callRunning(callId: string): Promise<boolean> {
  try { return !!(await callChatRuntime().lobbyOf(callId)); } catch { return false; }
}

/** The minutes card in the call chat: `text` is what the card shows under its title, the counts ride on the message. Never throws. */
async function postMinutesCard(callId: string, text: string, counts: MinutesCounts): Promise<void> {
  await postAsAssistant(callId, { text: text.replace(/\s+/g, ' ').trim() || NOTES.onPage, metadata: { assistant: true, displayName: ASSISTANT_NAME, kind: 'assistant-notice', meetingCallId: callId, minutes: counts } }, { minutes: true })
    .catch((error: unknown) => console.warn('[meeting-assistant] notice not posted', (error as Error).message));
}

/**
 * The chat notice when an addition a leave started could not be written. It promises another try only while the sweep will make one
 * (`attempt` runs made, under AUTO_ATTEMPTS); after that an attendee can still ask from the meeting page, within MAX_ATTEMPTS.
 */
export function additionFailedNotice(attempt: number): string {
  const head = `${ASSISTANT_NAME} could not add the later part of the call to the minutes.`;
  const kept = 'the transcript is kept for the people who were in the call';
  if (attempt < AUTO_ATTEMPTS) return `${head} The minutes so far are unchanged, ${ASSISTANT_NAME} will try again, and ${kept}.`;
  if (attempt < MAX_ATTEMPTS) return `${head} The minutes so far are unchanged, and ${kept}. Anyone who was in the call can ask ${ASSISTANT_NAME} to try again from the meeting page.`;
  return `${head} The minutes so far are unchanged, and ${kept}.`;
}
/** The plain sentence an addition's card shows when its own summary has no new sentence to quote. */
const ADDED_PLAIN = `${ASSISTANT_NAME} added the later part of the call to the minutes.`;

/**
 * Add what Milo heard since the minutes were written (it was invited back) to minutes that hold a draft. The writer reads only the newer
 * lines with the stored minutes as `earlier`; the store appends the new items after the stored ones under a compare on `throughSeq`, so
 * two additions at once write once. Nothing new: the minutes stay as they are (their end and attendees move) and no bell rings. A failed
 * or refused run marks the addition owed (`attempt` runs made) and leaves the minutes intact. `fromLeave` is the run a leave started (it
 * says so in the chat when it fails); the sweep's and an attendee's retries say nothing there.
 */
async function addToMinutes(callId: string, record: AssistantRecord, current: MinutesRecord, attempt: number, fromLeave: boolean): Promise<MinutesRecord | null> {
  const store = assistantStore();
  const expect = current.throughSeq ?? null;
  const lines = await linesForModels(record, await allLines(callId));
  const fresh = expect !== null ? lines.filter((l) => l.seq > expect) : lines.filter((l) => l.at > current.endedAt);
  // Where the stored minutes end: their last line. Not `endedAt`, which an owed addition already moved to the later leave, so a retry
  // that read it would find no later period and leave out what was done in the call then.
  const coveredUntil = expect !== null ? lines.reduce((n, l) => (l.seq <= expect ? Math.max(n, l.at) : n), 0) : current.endedAt;
  const attendees = [...new Set([...record.attendees, ...lines.flatMap((l) => (l.userId ? [l.userId] : []))])];
  const endedAt = record.leftAt ?? Date.now();
  if (!fresh.length) {
    const lastSeq = expect ?? lines.filter((l) => l.at <= current.endedAt).reduce((n, l) => Math.max(n, l.seq), 0);
    return store.appendMinutes(callId, expect, { summary: null, decisions: [], actionItems: [], topics: [], endedAt, attendees, lineCount: current.lineCount, throughSeq: lastSeq, truncated: false, added: false });
  }
  const roster: RosterEntry[] = await Promise.all(attendees.map(async (userId) => ({ userId, name: await nameOf(userId) })));
  const initiativeName = record.initiativeId ? await getProject(record.initiativeId).then((p) => p?.name ?? null).catch(() => null) : null;
  // Writes done in the call in its later periods (the earlier ones are in the minutes already; one run from the meeting page between
  // periods was not done in the call).
  const s = sessionOf(record);
  const later = [...(s.periods ?? []), { from: s.periodFrom ?? record.invitedAt, leftAt: endedAt }].filter((p) => p.from > coveredUntil);
  const turns = await store.listTurns(callId, { statuses: ['done'] }).catch(() => [] as AssistantTurn[]);
  const doneActions = turns.filter((t) => t.kind === 'write' && t.createdAt > coveredUntil && later.some((p) => t.createdAt >= p.from && t.createdAt <= p.leftAt))
    .map((t) => ({ text: doneActionText(t), ownerUserId: t.askedBy }));
  const proposals = (await store.listProposals(callId).catch(() => [])).filter((p) => p.state !== 'dismissed');
  const held = { statements: proposals.map((p) => p.statement), evidence: proposals.flatMap((p) => p.evidence) };
  const earlier = { summary: current.summary, decisions: current.decisions, topics: current.topics,
    actionItems: current.actionItems.map((i) => ({ text: i.text, ...(i.ownerName ? { ownerName: i.ownerName } : {}), ...(i.done ? { done: true } : {}) })) };
  const writer = (writerFactory ?? defaultMinutesWriterFactory)();
  let result: { draft: MinutesDraft | null; note: string | null; writer: MinutesWriterKind } = { draft: null, note: NOTES.noWriter, writer: 'none' };
  if (writer) {
    // The cost is booked to the person who invited Milo into this period (the record's current inviter).
    result = await Promise.race([
      writeDraft(record, writer, { lines: fresh, roster, callName: current.callName, doneActions, held, earlier }, { addition: (current.additions ?? 0) + 1, attempt }),
      new Promise<typeof result>((resolve) => { const t = setTimeout(() => resolve({ draft: null, note: NOTES.failed, writer: 'none' }), MINUTES_TIMEOUT_MS * 2 + 5000); t.unref?.(); }),
    ]);
  }
  if (!result.draft) {
    // The minutes so far stay exactly as they are; the addition is owed and the sweep (or an attendee) tries it again within the caps.
    const marked = await store.oweMinutesAddition(callId, expect, { attempts: attempt, endedAt, attendees });
    if (marked && fromLeave && writer) await postNoticeQuietly(callId, additionFailedNotice(attempt), { minutes: true });
    return store.getMinutes(callId);
  }
  const draft = result.draft;
  const decisions = withoutStored(withoutHeld(draft.decisions, held), current.decisions);
  const topics = draft.topics.filter((t) => !current.topics.includes(t));
  // A commitment said again after Milo was invited back is the same action item: it is not added (or offered as a card) twice.
  const actionItems = withoutStoredItems(draft.actionItems, current.actionItems);
  const stored = await store.appendMinutes(callId, expect, {
    summary: draft.summary || current.summary, decisions, actionItems, topics, endedAt, attendees,
    lineCount: current.lineCount + fresh.length, throughSeq: fresh[fresh.length - 1]!.seq, truncated: draft.truncated, added: true,
  });
  if (!stored) return null; // another addition of the same lines won
  const fromIndex = stored.actionItems.length - actionItems.length;
  // The card announces the change: the addition's own sentence, and counts of what is NEW (its decision lines and action items, and the
  // proposals raised in the later part, with those of them already agreed counted as decisions too).
  const raised = (await store.listProposals(callId).catch(() => proposals)).filter((p) => p.createdAt > coveredUntil);
  const counts: MinutesCounts = { ...minutesCounts({ decisions, actionItems }, raised), added: true };
  await postMinutesCard(callId, chatSummary(additionSentence(current.summary, stored.summary)) || ADDED_PLAIN, counts);
  await notifyMinutesReady(stored);
  await offerCards(record, stored, initiativeName, fromIndex).catch((e: unknown) => console.warn('[meeting-assistant] action cards not offered', (e as Error).message));
  return stored;
}

/** The sweep's part: try each failed write again, up to AUTO_ATTEMPTS runs in all. Returns how many were tried. Never throws. */
export async function retryFailedMinutes(limit = 20): Promise<number> {
  try {
    let tried = 0;
    const due = await assistantStore().listRetryableMinutes(AUTO_ATTEMPTS, limit);
    lastRetryFailure = null;
    for (const m of due) {
      const { outcome, done } = await rewriteMinutes(m.callId, AUTO_ATTEMPTS);
      if (outcome === 'started') { tried += 1; await done; }
    }
    return tried;
  } catch (e) {
    // A deployment without the tables would say this every run: once, and again only when the message changes.
    const message = (e as Error).message;
    if (message !== lastRetryFailure) console.warn('[meeting-assistant] minutes retry sweep failed (will keep trying)', message);
    lastRetryFailure = message;
    return 0;
  }
}
let lastRetryFailure: string | null = null;

/** Every few minutes, the failed writes are tried again (unref'd). Returns the stopper. */
export function startMinutesRetrySweep(everyMs = 10 * 60_000): () => void {
  const timer = setInterval(() => { void retryFailedMinutes(); }, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function doneActionText(turn: AssistantTurn): string {
  const a = (turn.tool.args ?? {}) as { kind?: unknown; fields?: { title?: unknown; name?: unknown } };
  const title = typeof a.fields?.title === 'string' ? a.fields.title : typeof a.fields?.name === 'string' ? a.fields.name : '';
  const kind = typeof a.kind === 'string' ? a.kind.replace(/-/g, ' ') : '';
  return turn.tool.name === 'create' && title ? `Created ${kind || 'a record'}: ${title}` : `Ran ${turn.tool.name}`;
}

/** The runtime's `onFinished` and the call-end signal call this; it never throws and never blocks the caller. */
export function finishMinutes(callId: string): Promise<void> {
  return track(writeMinutes(callId).then(() => undefined, (e: unknown) => { console.warn('[meeting-assistant] minutes failed', (e as Error).message); }));
}

/**
 * The call ended while the assistant was present: it leaves with the call (the same settle as a dismissal), then the minutes
 * are written. Nothing is posted into the chat but the minutes message: the call is over.
 */
export async function onCallEnded(callId: string, deps: { stop: (callId: string) => Promise<void>; stopIntake: (callId: string) => void }): Promise<void> {
  const store = assistantStore();
  const record = await store.get(callId);
  if (!record) return;
  if (record.state !== 'left') {
    const done = await store.transition(callId, { from: ['invited', 'listening', 'paused'], to: 'left', by: 'system', at: Date.now() });
    if (!done) return;
  }
  deps.stopIntake(callId);
  await deps.stop(callId);
  // With no run in this process `stop` settles nothing: book the used minutes from the record (a no-op once settled).
  await (await import('./reconcile.js')).settleFromRecord(callId);
  // `stop` runs `onFinished` only for a call with a live run; make sure the minutes are written either way.
  await finishMinutes(callId);
}
