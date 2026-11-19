// The erasers this module registers (contract D6; rules.ts says which class each is). Each one is a factory over its
// dependencies, so the tests build them with fakes; `registerOwnErasers()` registers them with the real ones, once.
//
//   recording               media   platform-api's `POST /internal/recordings/erase` (contract D5), service-signed as
//                                   `/internal/video-sessions/*` is: the body-only envelope in SERVICE_AUTH_HEADER, the
//                                   SERVICE_AUTH_SECRET, the service id RECORDING_ERASE_SERVICE_ID (else
//                                   `aws-agentcore`, platform-api's default RECORDING_ERASE_SERVICE_IDS). Where no platform-api is configured (the plain mock world) there
//                                   is nothing to call: EraserSkipped, which the log records as such. A configured URL
//                                   without the secret, a refusal or a timeout is a failure the next sweep retries.
//   transcript-and-minutes  media   every call Milo kept for the interview's lobby, through the meeting assistant's own
//                                   `eraseCall` (the stored lines, the minutes become a tombstone, Milo's chat lines are
//                                   replaced), as the inviter's delete does, and then `purgeCall`: the tombstone, the turns,
//                                   the actions, the proposals and the record go too, which is everything the meeting
//                                   assistant's own age sweep removes for a call (its sweep leaves interview calls to this
//                                   one, policy.ts `keepsOwnRetention`). One count per call that still held words. A call
//                                   Milo is listening to cannot be erased: EraserBusy, retried.
//   consents, scorecards    record  records.ts's own statements.
// The suggestion log's eraser is the coach's (`eraseSuggestions`), registered by the integrator.
//
// The mock world has no media server and, for the seeded finished interviews, no stored call: their recording and words are
// stand-ins (mock/interviews-records.ts) the record reads in place of them. There, and only there, the recording and the
// words erasers also remove the interview's stand-ins and count them as they would a recording or a call, so a seeded
// record past its period, or after a deletion request, reads as removed (hardening H5, finding 4). Outside the mock world
// `mockStandIns` touches nothing and both erasers behave as described above.

import { eraseSuggestions } from '../coach/index.js';
import { eraseRecaps } from '../recap/index.js';
import { eraseCoachLog } from '../milo-notes/index.js';
import { eraseSaidLog } from '../speak/index.js';
import { erasePadLog } from '../pad/log/index.js';
import { eraseBoardSnapshots } from '../board/snapshots.js';
import { eraseRuns } from '../runs/index.js';
import { SERVICE_AUTH_HEADER, signEnvelope } from '@connorhoehn/service-runtime';
import type { AssistantStore } from '../../meeting-assistant/store.js';
import { EraserBusy, EraserSkipped, registerEraser, type Eraser } from './registry.js';
import { recordStatements, type RecordStatements } from './records.js';
import { interviewLobby } from './rules.js';
import { interviewsNowMs } from '../clock.js';
import { config } from '../../../config.js';
import { interviewRecordLinesFixture, interviewRecordingsFixture } from '../../../mock/interviews-records.js';

export const RECORDING_ERASE_PATH = '/internal/recordings/erase';
const RECORDING_TIMEOUT_MS = 8_000;

/** Where platform-api answers this service (the same settings the social proxy reads), or null. */
export function recordingServiceUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env['SOCIAL_PLATFORM_INTERNAL_URL'] || env['DOCUMENT_PLATFORM_INTERNAL_URL'] || env['PLATFORM_API_URL'] || '';
  return url.trim() ? url.trim().replace(/\/+$/, '') : null;
}

/**
 * The one signer for this service's calls to platform-api's /internal/recordings routes: the request headers for `body`, signed as
 * the service (platform-api accepts a recording call only from its RECORDING_ERASE_SERVICE_IDS, default `aws-agentcore`).
 * Null when no SERVICE_AUTH_SECRET is set.
 */
export function signedRecordingHeaders(body: string | object, env: NodeJS.ProcessEnv = process.env): Record<string, string> | null {
  const secret = env['SERVICE_AUTH_SECRET']?.trim();
  if (!secret) return null;
  const serviceId = env['RECORDING_ERASE_SERVICE_ID']?.trim() || 'aws-agentcore';
  return { 'content-type': 'application/json', [SERVICE_AUTH_HEADER]: signEnvelope(body, { secret, serviceId }) };
}

/** The mock world's seeded stand-ins for a recording and a stored call's words. Each removes those of the given interviews and answers which interviews had one. */
export interface StandIns {
  recordings(interviewIds: readonly string[]): string[];
  words(interviewIds: readonly string[]): string[];
}

/** Removes the rows of `rows` that `match`, in place; answers the removed rows. */
function takeWhere<T>(rows: T[], match: (r: T) => boolean): T[] {
  const taken: T[] = [];
  for (let k = rows.length - 1; k >= 0; k -= 1) if (match(rows[k]!)) taken.unshift(...rows.splice(k, 1));
  return taken;
}

/** The seeded stand-ins, in the mock world only: outside it there are none to remove and nothing is touched. */
export const mockStandIns: StandIns = {
  recordings(ids) {
    if (!config.mock?.aurora) return [];
    return [...new Set(takeWhere(interviewRecordingsFixture.rows(), (r) => ids.includes(r.interviewId)).map((r) => r.interviewId))];
  },
  words(ids) {
    if (!config.mock?.aurora) return [];
    return [...new Set(takeWhere(interviewRecordLinesFixture.rows(), (l) => ids.includes(l.interviewId)).map((l) => l.interviewId))];
  },
};

export interface RecordingDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  standIns: StandIns;
}

export function recordingEraser(deps: Partial<RecordingDeps> = {}): Eraser {
  return {
    kind: 'recording', class: 'media',
    async erase(interviewIds) {
      const env = deps.env ?? process.env;
      const base = recordingServiceUrl(env);
      // The mock world's stand-in recordings go with the interview, as a recording on the media server would.
      const standIns = (deps.standIns ?? mockStandIns).recordings(interviewIds).length;
      if (!base) {
        if (standIns > 0) return standIns;
        throw new EraserSkipped('no-service');
      }
      if (!signedRecordingHeaders({}, env)) throw new Error('SERVICE_AUTH_SECRET is not set, so recordings cannot be erased.');
      const doFetch = deps.fetch ?? fetch;
      let erased = standIns;
      for (const id of interviewIds) {
        const body = { lobbyName: interviewLobby(id), purpose: 'recording-erase' };
        const res = await doFetch(`${base}${RECORDING_ERASE_PATH}`, {
          method: 'POST',
          headers: signedRecordingHeaders(body, env)!,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(RECORDING_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`The recording service answered ${res.status}.`);
        const answer = (await res.json().catch(() => ({}))) as { erased?: unknown };
        erased += typeof answer.erased === 'number' && answer.erased >= 0 ? answer.erased : 0;
      }
      return erased;
    },
  };
}

export interface CallWordsDeps {
  store: () => AssistantStore;
  eraseCall: (store: AssistantStore, callId: string, by: string, at: number) => Promise<number | null>;
  now: () => number;
  standIns: StandIns;
}

/** Loaded on demand, so the retention tests never pull in the call chat stack. */
const defaultCallWords: CallWordsDeps = {
  store: () => { throw new Error('not loaded'); },
  eraseCall: async (store, callId, by, at) => (await import('../../meeting-assistant/erase.js')).eraseCall(store, callId, by, at),
  now: interviewsNowMs,
  standIns: mockStandIns,
};

/** How many calls of one lobby are looked at per interview; an interview has one call, so this is generous. */
const CALLS_PER_INTERVIEW = 50;

export function callWordsEraser(deps: Partial<CallWordsDeps> = {}): Eraser {
  const d = { ...defaultCallWords, ...deps };
  return {
    kind: 'transcript-and-minutes', class: 'media',
    async erase(interviewIds) {
      const store = deps.store ? deps.store() : (await import('../../meeting-assistant/store-select.js')).assistantStore();
      let erased = 0;
      let busy = false;
      const withCall = new Set<string>();
      for (const id of interviewIds) {
        for (const call of await store.callsOfLobby(interviewLobby(id), CALLS_PER_INTERVIEW)) {
          withCall.add(id);
          if (call.state === 'listening' || call.state === 'paused') { busy = true; continue; }
          const minutes = await store.getMinutes(call.callId);
          const lines = await d.eraseCall(store, call.callId, 'retention', d.now());
          if (lines === null) { busy = true; continue; }
          // What the age sweep would also remove: the record and everything left under it (false only if Milo came back meanwhile).
          if (!(await store.purgeCall(call.callId))) { busy = true; continue; }
          if (lines > 0 || (minutes !== null && !minutes.deleted)) erased += 1;
        }
      }
      // The record reads a stand-in only where no stored call is found; those count as a call each. A stand-in under an
      // interview that had a stored call was never shown, and goes without a count.
      erased += d.standIns.words(interviewIds).filter((id) => !withCall.has(id)).length;
      if (busy) throw new EraserBusy('call-running', erased);
      return erased;
    },
  };
}

export function consentsEraser(records: () => RecordStatements = recordStatements): Eraser {
  return { kind: 'consents', class: 'record', erase: (ids) => records().eraseConsents(ids) };
}
export function scorecardsEraser(records: () => RecordStatements = recordStatements): Eraser {
  return { kind: 'scorecards', class: 'record', erase: (ids) => records().eraseScorecards(ids) };
}

let registered = false;
/** Register this module's erasers with their real dependencies. Safe to call twice. */
export function registerOwnErasers(): void {
  if (registered) return;
  registered = true;
  registerEraser(recordingEraser());
  registerEraser(callWordsEraser());
  registerEraser(consentsEraser());
  registerEraser(scorecardsEraser());
  registerEraser({ kind: 'suggestions', class: 'record', erase: eraseSuggestions });
  registerEraser({ kind: 'recaps', class: 'record', erase: eraseRecaps });
  registerEraser({ kind: 'coach-log', class: 'record', erase: eraseCoachLog });
  registerEraser({ kind: 'said-log', class: 'record', erase: eraseSaidLog });
  registerEraser({ kind: 'pad-log', class: 'media', erase: erasePadLog });
  registerEraser({ kind: 'board-snapshots', class: 'media', erase: eraseBoardSnapshots });
  registerEraser({ kind: 'runs', class: 'media', erase: eraseRuns });
}
