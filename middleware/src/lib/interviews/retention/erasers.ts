// The erasers this module registers (contract D6; rules.ts says which class each is). Each one is a factory over its
// dependencies, so the tests build them with fakes; `registerOwnErasers()` registers them with the real ones, once.
//
//   recording               media   platform-api's `POST /internal/recordings/erase` (contract D5), service-signed as
//                                   `/internal/video-sessions/*` is: the body-only envelope in SERVICE_AUTH_HEADER, the
//                                   SERVICE_AUTH_SECRET, the service id WORK_GRAPH_GATEWAY_SERVICE_ID (else
//                                   `realtime-examples`). Where no platform-api is configured (the plain mock world) there
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

import { eraseSuggestions } from '../coach/index.js';
import { eraseRecaps } from '../recap/index.js';
import { eraseCoachLog } from '../milo-notes/index.js';
import { erasePadLog } from '../pad/log/index.js';
import { SERVICE_AUTH_HEADER, signEnvelope } from '@connorhoehn/service-runtime';
import type { AssistantStore } from '../../meeting-assistant/store.js';
import { EraserBusy, EraserSkipped, registerEraser, type Eraser } from './registry.js';
import { recordStatements, type RecordStatements } from './records.js';
import { interviewLobby } from './rules.js';
import { interviewsNowMs } from '../clock.js';

export const RECORDING_ERASE_PATH = '/internal/recordings/erase';
const RECORDING_TIMEOUT_MS = 8_000;

/** Where platform-api answers this service (the same settings the social proxy reads), or null. */
export function recordingServiceUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = env['SOCIAL_PLATFORM_INTERNAL_URL'] || env['DOCUMENT_PLATFORM_INTERNAL_URL'] || env['PLATFORM_API_URL'] || '';
  return url.trim() ? url.trim().replace(/\/+$/, '') : null;
}

export interface RecordingDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
}

export function recordingEraser(deps: Partial<RecordingDeps> = {}): Eraser {
  return {
    kind: 'recording', class: 'media',
    async erase(interviewIds) {
      const env = deps.env ?? process.env;
      const base = recordingServiceUrl(env);
      if (!base) throw new EraserSkipped('no-service');
      const secret = env['SERVICE_AUTH_SECRET']?.trim();
      if (!secret) throw new Error('SERVICE_AUTH_SECRET is not set, so recordings cannot be erased.');
      const serviceId = env['WORK_GRAPH_GATEWAY_SERVICE_ID']?.trim() || 'realtime-examples';
      const doFetch = deps.fetch ?? fetch;
      let erased = 0;
      for (const id of interviewIds) {
        const body = { lobbyName: interviewLobby(id) };
        const res = await doFetch(`${base}${RECORDING_ERASE_PATH}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SERVICE_AUTH_HEADER]: signEnvelope(body, { secret, serviceId }) },
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
}

/** Loaded on demand, so the retention tests never pull in the call chat stack. */
const defaultCallWords: CallWordsDeps = {
  store: () => { throw new Error('not loaded'); },
  eraseCall: async (store, callId, by, at) => (await import('../../meeting-assistant/erase.js')).eraseCall(store, callId, by, at),
  now: interviewsNowMs,
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
      for (const id of interviewIds) {
        for (const call of await store.callsOfLobby(interviewLobby(id), CALLS_PER_INTERVIEW)) {
          if (call.state === 'listening' || call.state === 'paused') { busy = true; continue; }
          const minutes = await store.getMinutes(call.callId);
          const lines = await d.eraseCall(store, call.callId, 'retention', d.now());
          if (lines === null) { busy = true; continue; }
          // What the age sweep would also remove: the record and everything left under it (false only if Milo came back meanwhile).
          if (!(await store.purgeCall(call.callId))) { busy = true; continue; }
          if (lines > 0 || (minutes !== null && !minutes.deleted)) erased += 1;
        }
      }
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
  registerEraser({ kind: 'pad-log', class: 'media', erase: erasePadLog });
}
