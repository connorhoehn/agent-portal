// What every interview tool shares: the interview behind a request, where the asker stands in it, the fixed sentences, and the said
// log (family.ts `log`). Tests replace the dependencies with `setMiloToolDeps`.
import { randomBytes } from 'node:crypto';
import { runWithDbTenant } from '../../../providers/db-tenant.js';
import { interviewsNowMs } from '../clock.js';
import { guestOfInterview, isGuestId } from '../guest-id.js';
import { miloSettingsStore, type MiloSettings } from '../milo-settings.js';
import { appendPadEvents, MILO_WRITER_ID } from '../pad/log/service.js';
import type { PadEventIn } from '../pad/log/rules.js';
import { writeIntoPad, type MiloPadPlan, type MiloPadWriteResult } from '../pad/milo-writer.js';
import { saidStore, type SaidSource } from '../speak/store.js';
import { interviewsStore } from '../store-select.js';
import { roundSurface } from '../kit.js';
import { answerKeyText, candidateQuestion, type CandidateQuestion } from '../answer-key.js';
import { boardSnapshotStore } from '../board/snapshots.js';
import { INTERVIEWS_TENANT, type Interview, type KitQuestion, type RoundSurface } from '../types.js';
import { judgeHelper, type VerdictInput } from './verdict.js';
import type { PadWriterChoice, PadWriterInput } from './writer.js';
import { PROBE_HEARD_LINES, PROBE_HEARD_MS, type HeardLine, type ProbeInput } from './probe.js';

export type Standing = 'lead' | 'panel' | 'candidate';

/**
 * A live interview as Milo's tools see it: the record and where its round is worked (the kit round's surface: the code pad, the
 * whiteboard, or neither for a behavioural round). The pad tools follow the surface, never the round's type alone.
 */
export type MiloInterview = Interview & { surface: RoundSurface | null };

// ── The fixed sentences ──────────────────────────────────────────────────────────────────────────────────────────────────
export const PAD_OFF = "The lead hasn't turned on pad help from Milo for this round.";
export const PAD_LEAD_ONLY = 'Only the lead interviewer, or the candidate when the lead allows it, can ask Milo to change the pad.';
export const INTRO_LEAD_ONLY = 'Only the lead interviewer can ask Milo to introduce itself.';
export const NO_PAD = 'There is no code pad in this round.';
export const NO_BOARD = "I can't add to the board yet.";
export const PAD_BUSY = 'Milo is still writing in the pad.';
export const NOT_SOLUTION = "I can add test cases, imports or a helper, but I can't write the solution.";
export const NOT_STANDARD_IMPORT = 'Milo only adds standard-library imports at the top of the pad.';
export const NOTHING_NEW = 'The pad already has that.';
export const HELPER_NOT_ADDED = "Milo couldn't add that helper to the pad.";
export const TESTS_NOT_ADDED = "Milo couldn't add those test cases to the pad.";
export const PAD_FAILED = "Milo couldn't change the pad this time.";
export const PAD_TOO_LONG = 'The pad is too long for Milo to change.';
export const TESTS_LIMIT = 'Milo has already added test cases three times in this round.';
export const ON_IT = 'On it.';
/** The most times Milo writes test cases in one interview. */
export const MAX_TEST_CASE_BATCHES = 3;
/** At most this many pad changes by Milo in one interview (test cases, imports and helpers together). */
export const MAX_PAD_CHANGES = 12;
/** At most this many solution checks (a model call each) in one interview, whatever they found. */
export const MAX_VERDICTS = 10;
export const PAD_CHANGES_LIMIT = 'Milo has made all the pad changes it can in this interview.';
/** Argument-less tools heard twice for one request (the phrase and the model's call): the second within this is not run. */
export const REPEAT_WINDOW_MS = 20_000;

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
export const countWords = (n: number): string => NUMBER_WORDS[n] ?? String(n);
export const testsAddedLine = (n: number, checked: boolean, missing: readonly string[] = [], assumed = false, unchecked = 0): string => `${unchecked > 0 && unchecked < n
  ? `Added ${countWords(n - unchecked)} test case${n - unchecked === 1 ? '' : 's'} at the bottom of the pad, plus ${countWords(unchecked)} input${unchecked === 1 ? '' : 's'} with no expected result yet.`
  : checked
  ? `Added ${countWords(n)} test case${n === 1 ? '' : 's'} at the bottom of the pad.`
  : `Added ${countWords(n)} test input${n === 1 ? '' : 's'} at the bottom of the pad. The expected values are yours to fill in.`}${assumed ? ' I assumed an empty list when there is no pair.' : ''}${missing.length ? ` I couldn't write one for ${missing.join(' or ')}.` : ''}`;
export const importsAddedLine = (n: number): string => (n === 1 ? 'Added the import at the top of the pad.' : `Added ${countWords(n)} imports at the top of the pad.`);
export const HELPER_ADDED = 'Added the helper at the top of the pad, marked as added by Milo.';

// ── The interview behind a request ───────────────────────────────────────────────────────────────────────────────────────

export interface MiloToolDeps {
  interview: (interviewId: string) => Promise<Interview | null>;
  /** The guest id was minted for this interview (milo-policy.ts). */
  guestOf: (userId: string, interviewId: string) => Promise<boolean>;
  settings: (interviewId: string) => Promise<MiloSettings>;
  /** The round's questions as the candidate's side may hold them (answer-key.ts): Milo speaks and writes in the candidate's call. */
  questions: (interview: Interview) => Promise<CandidateQuestion[]>;
  /** Where the interview's round is worked (kit.ts `roundSurface`). */
  surface: (interview: Interview) => Promise<RoundSurface | null>;
  write: (interviewId: string, plan: MiloPadPlan) => Promise<MiloPadWriteResult>;
  padLog: (interviewId: string, events: readonly PadEventIn[], at: Date) => Promise<number>;
  judge: (interviewId: string, leadId: string, input: VerdictInput) => Promise<'helper' | 'solution'>;
  /** One pad request, in the asker's words, written as one pad tool's call (writer.ts); null: nothing Milo adds. */
  writer: (interview: Interview, input: PadWriterInput) => Promise<PadWriterChoice | null>;
  /** The round's board as it was last saved: the scene's elements, or null (no board, nothing saved yet). */
  board: (interview: Interview) => Promise<Array<Record<string, unknown>> | null>;
  /** The last lines of the call's transcript, oldest first; none when the transcript was not accepted. */
  heard: (interview: Interview) => Promise<HeardLine[]>;
  /** The round's answer key as text (answer-key.ts `answerKeyText`): what Milo must never say. A throw: unread, so nothing is said. */
  answerKey: (interview: Interview) => Promise<string[]>;
  /** One probing question for the candidate, written for the topic (probe.ts), not yet checked; null: none. */
  prober: (interview: Interview, input: ProbeInput) => Promise<string | null>;
  /** A person's display name from the directory, or null (no account here). */
  personName: (userId: string) => Promise<string | null>;
  now: () => number;
  newId: () => string;
}

async function openingOf(interview: Interview) {
  const store = interviewsStore();
  const [applications, openings] = await runWithDbTenant(INTERVIEWS_TENANT, () => Promise.all([store.listApplications(), store.listOpenings()]));
  return openings.find((o) => o.id === applications.find((a) => a.id === interview.applicationId)?.openingId) ?? null;
}

/** The round's technical questions as the kit holds them, answer key and all: never handed on unprojected. */
async function kitQuestions(interview: Interview): Promise<KitQuestion[]> {
  const opening = await openingOf(interview);
  const bank = opening?.kit.questions ?? [];
  const chosen = interview.questionIds.length ? bank.filter((q) => interview.questionIds.includes(q.id)) : bank;
  return chosen.filter((q) => q.roundType === 'technical');
}
const roundQuestions = async (interview: Interview): Promise<CandidateQuestion[]> => (await kitQuestions(interview)).map(candidateQuestion);

/** The call's last lines, when the candidate accepted the transcript (the newest page of it, at most ten pages in). */
async function lastHeard(interview: Interview): Promise<HeardLine[]> {
  const [{ coachConsents }, { assistantLiveTranscript, sideOf }] = await Promise.all([import('../coach/service.js'), import('../milo-notes/transcript.js')]);
  if (!(await coachConsents(interview.id))?.transcription) return [];
  let after = 0; let lines: HeardLine[] = [];
  for (let page = 0; page < 10; page++) {
    const t = await assistantLiveTranscript({ id: interview.id, callId: interview.callId }, after);
    if (!t || t.lastSeq <= after) break;
    // The last two minutes of the newest page (at most PROBE_HEARD_LINES): enough of the talk for a probe about it.
    const newest = t.lines.at(-1)?.atMs ?? 0;
    if (t.lines.length) lines = t.lines.filter((l) => l.atMs >= newest - PROBE_HEARD_MS).slice(-PROBE_HEARD_LINES).map((l) => ({ side: sideOf(l.userId), text: l.text }));
    after = t.lastSeq;
  }
  return lines;
}

const DEFAULTS: MiloToolDeps = {
  interview: async (id) => (await runWithDbTenant(INTERVIEWS_TENANT, () => interviewsStore().listInterviews())).find((i) => i.id === id) ?? null,
  guestOf: guestOfInterview,
  settings: (id) => runWithDbTenant(INTERVIEWS_TENANT, () => miloSettingsStore().get(id)),
  questions: roundQuestions,
  surface: async (interview) => {
    const round = (await openingOf(interview))?.kit.rounds.find((r) => r.id === interview.roundId);
    return roundSurface({ type: interview.type, surface: round?.surface });
  },
  write: writeIntoPad,
  padLog: (id, events, at) => runWithDbTenant(INTERVIEWS_TENANT, () => appendPadEvents(id, { id: MILO_WRITER_ID, side: 'milo' }, events, at)),
  judge: judgeHelper,
  // Loaded when first asked: writer.ts imports the pad tools, which import this module.
  writer: async (interview, input) => (await import('./writer.js')).writePadRequest(interview, input),
  board: async (interview) => {
    const last = await runWithDbTenant(INTERVIEWS_TENANT, () => boardSnapshotStore().latest(interview.id));
    if (!last) return null;
    const scene: unknown = JSON.parse(last.scene);
    return Array.isArray(scene) ? (scene as Array<Record<string, unknown>>) : null;
  },
  heard: lastHeard,
  answerKey: async (interview) => answerKeyText(await kitQuestions(interview)),
  prober: async (interview, input) => (await import('./probe.js')).writeProbe(interview, input),
  personName: async (userId) => {
    const { listUsers } = await import('../../../providers/identity.js');
    return (await listUsers()).find((u) => u.id === userId)?.displayName ?? null;
  },
  now: interviewsNowMs,
  newId: () => `said-${randomBytes(8).toString('hex')}`,
};
let overrides: Partial<MiloToolDeps> = {};
/** Tests: replace some dependencies; `null` puts every default back. */
export function setMiloToolDeps(next: Partial<MiloToolDeps> | null): void { overrides = next ?? {}; }
export const deps = (): MiloToolDeps => ({ ...DEFAULTS, ...overrides });

/** A live interview by id with its round's surface, or null (not found, not live, unreadable). An unreadable surface is none. */
export async function liveInterview(interviewId: string): Promise<MiloInterview | null> {
  const d = deps();
  const interview = await d.interview(interviewId).catch(() => null);
  if (!interview || interview.state !== 'live') return null;
  return { ...interview, surface: await d.surface(interview).catch(() => null) };
}

/** Where this person stands in the interview: its lead, on its panel, its candidate (a guest of its invite), or nowhere. */
export async function standingOf(interview: Interview, userId: string): Promise<Standing | null> {
  if (userId === interview.leadId) return 'lead';
  if (interview.panelIds.includes(userId)) return 'panel';
  if (isGuestId(userId) && (await deps().guestOf(userId, interview.id).catch(() => false))) return 'candidate';
  return null;
}

/** May the candidate ask Milo to change the pad (the lead's switch, milo-settings.ts)? Unreadable: no. */
export const candidateMayAsk = async (interview: Interview): Promise<boolean> => !!(await deps().settings(interview.id).catch(() => null))?.candidateMayAsk;

/** A line Milo will say, logged in the said log, unposted (the orchestrator posts and says it; `heldTextSaid` marks the row). */
export async function logLine(interview: Interview, askedBy: string, said: { line: string; source: SaidSource }): Promise<string> {
  const d = deps();
  await runWithDbTenant(INTERVIEWS_TENANT, () => saidStore().append({
    id: d.newId(), interviewId: interview.id, callId: interview.callId, kind: 'answer', source: said.source, questionId: null, suggestionId: null,
    text: said.line, askedBy, saidAt: new Date(d.now()).toISOString(), posted: false, spoken: false,
  }));
  return said.line;
}
