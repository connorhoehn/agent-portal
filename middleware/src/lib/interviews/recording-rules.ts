// Whether an interview's call records, and who may list or play its recording (docs/interviews-tenant-plan.md row I2.6, this
// repository's half; contracts D2 and D3). platform-api asks both, through routes/realtime-lobby-access.ts; it fails closed on
// anything but a 200 with a yes.
//
//   D2, the decision   asked by someone who holds a seat in the interview's call now (the same admission /lobby-access gives).
//                      Recording follows the candidate's recording answer alone, the transcript the transcript answer alone
//                      (consent/effects.ts). No usable answers: neither. "Usable" is the panel's read's rule
//                      (routes/interviews/consents.ts): stored under the current notice, or, once the call has started, the
//                      answers it started with. Anyone without a seat, and every other lobby, gets the refusal.
//   D3, the access     the panel side of that interview (decision 4): its lead, its panel, a recruiter, the opening's
//                      hiring manager, by the tenant's one scope rule, whatever the interview's state. Never a guest, never
//                      the admin (round 3 decided the same for the transcript), never another tenant.
//
// The rules are pure; the loaders read the store, the consents and the directory now, every time. Nothing here logs an answer.
import { isAllowed } from '../authz.js';
import { runWithDbTenant } from '../../providers/db-tenant.js';
import { CONSENT_NOTICE } from './consent/notice.js';
import { consentsChangeable, type ConsentAnswers } from './consent/rules.js';
import { consentStore, type ConsentRecord } from './consent/store.js';
import { interviewRunsWith } from './consent/effects.js';
import { interviewsEnabled } from './flag.js';
import { CALL_STATES, claimsGuest, interviewOfLobby } from './lobby.js';
import { onPanelSide } from './milo-policy.js';
import { interviewsStore } from './store-select.js';
import { INTERVIEWS_TENANT, type Interview, type InterviewState } from './types.js';

export type RecordingReason = 'interview-consented' | 'interview-recording-declined' | 'interview-consent-missing' | 'interview-not-open';
export type RecordingDecision =
  | { status: 200; body: { record: boolean; transcribe: boolean; reason: RecordingReason; decisionVersion: number } }
  | { status: 403; body: { record: false; transcribe: false } };

export const RECORDING_REFUSED: RecordingDecision = Object.freeze({ status: 403, body: Object.freeze({ record: false, transcribe: false }) }) as RecordingDecision;

/** The answers that count for an interview in `state`: the panel's read's rule. Null when none do. */
export function usableAnswers(record: Pick<ConsentRecord, 'noticeVersion' | 'recording' | 'transcription' | 'milo'> | null, state: InterviewState,
  currentNotice: string = CONSENT_NOTICE.version): ConsentAnswers | null {
  if (!record) return null;
  if (record.noticeVersion !== currentNotice && consentsChangeable(state)) return null;
  return { recording: record.recording, transcription: record.transcription, milo: record.transcription && record.milo };
}

export interface RecordingDecisionFacts {
  /** The bearer holds a seat in this interview's call now. */
  seated: boolean;
  /** The interview's state as read after the seat (null: it is gone). */
  state: InterviewState | null;
  /** The usable answers (usableAnswers). */
  answers: ConsentAnswers | null;
  /** The consent row's revision (monotonic in the mock and SQL stores), 0 when there is no row: platform-api orders decisions by it. */
  version?: number;
}

/** D2, pure. */
export function recordingDecision(f: RecordingDecisionFacts): RecordingDecision {
  if (!f.seated) return RECORDING_REFUSED;
  const decisionVersion = f.version ?? 0;
  if (!f.state || !CALL_STATES.includes(f.state)) return { status: 200, body: { record: false, transcribe: false, reason: 'interview-not-open', decisionVersion } };
  if (!f.answers) return { status: 200, body: { record: false, transcribe: false, reason: 'interview-consent-missing', decisionVersion } };
  const runs = interviewRunsWith(f.answers);
  return { status: 200, body: { record: runs.recording, transcribe: runs.transcript, reason: runs.recording ? 'interview-consented' : 'interview-recording-declined', decisionVersion } };
}

export interface RecordingAccessFacts {
  flagOn: boolean;
  /** The bearer is (or claims to be) a guest. */
  guest: boolean;
  tenant: string;
  role: string;
  /** The role holds ViewInterviews in the tenant now. */
  mayView: boolean;
  /** The interview is in the bearer's scope (the tenant's one scope rule). */
  panelSide: boolean;
}

/** D3, pure. */
export function recordingAccessAllowed(f: RecordingAccessFacts): boolean {
  return f.flagOn && !f.guest && f.tenant === INTERVIEWS_TENANT && f.role !== 'admin' && f.mayView && f.panelSide;
}

// ── Loaders, read now ────────────────────────────────────────────────────────────────────────────────────────────────────

const findInterview = (interviewId: string): Promise<Interview | null> =>
  runWithDbTenant(INTERVIEWS_TENANT, async () => (await interviewsStore().listInterviews()).find((i) => i.id === interviewId) ?? null);

/**
 * D2 for a lobby, once the caller has decided whether the bearer is seated (the route asks the gateway's own admission). A lobby
 * that is not an interview's is refused before anything is read.
 */
export async function decideRecording(lobbyName: string, seated: () => Promise<boolean>): Promise<RecordingDecision> {
  const interviewId = interviewOfLobby(lobbyName);
  if (!interviewId || !interviewsEnabled()) return RECORDING_REFUSED;
  if (!await seated().catch(() => false)) return RECORDING_REFUSED;
  // A store that fails is the refusal (fail closed), never a 500: nothing records on a read that did not happen.
  try {
    const interview = await findInterview(interviewId);
    const record = interview ? await runWithDbTenant(INTERVIEWS_TENANT, () => consentStore().getConsent(interviewId)) : null;
    return recordingDecision({ seated: true, state: interview?.state ?? null, answers: interview ? usableAnswers(record, interview.state) : null, version: record?.revision ?? 0 });
  } catch {
    return RECORDING_REFUSED;
  }
}

/** D3 for a lobby and a verified token context; `session` loads the directory-checked session (never asked for a guest). */
export async function decideRecordingAccess(lobbyName: string, ctx: Record<string, unknown>,
  session: () => Promise<{ sub: string; tenant: string; role: string }>): Promise<boolean> {
  const interviewId = interviewOfLobby(lobbyName);
  if (!interviewId || !interviewsEnabled() || claimsGuest(ctx)) return false;
  try {
    const s = await session();
    const facts = { flagOn: true, guest: false, tenant: s.tenant, role: s.role, mayView: false, panelSide: false };
    if (!recordingAccessAllowed({ ...facts, mayView: true, panelSide: true })) return false;
    facts.mayView = await isAllowed({ sub: s.sub, tenant: s.tenant as never, role: s.role as never }, 'ViewInterviews');
    if (!facts.mayView) return false;
    facts.panelSide = await runWithDbTenant(INTERVIEWS_TENANT, () => onPanelSide({ userId: s.sub, tenant: s.tenant, role: s.role }, interviewId));
    return recordingAccessAllowed(facts);
  } catch { return false; }
}
