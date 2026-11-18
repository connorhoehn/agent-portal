// A saved consent answer, pushed to platform-api while the interview's call may be live.
//
// POST /internal/recordings/interview-decision { lobbyName, purpose, record, transcribe, reason, decisionVersion } switches recording on or off in a call that
// is already running. The values are the BFF's own D2 answer for the lobby (decideRecording), so the push and the /recording-decision
// route never disagree. Signed as the same service as the recording erase. Best effort: it never throws, and a failure is one warning.
// A thrown fetch, a timeout or any 5xx is tried again (a lost decline would keep recording); a 4xx is not. This in-process push is fire-and-forget:
// a BFF restart mid-retry is covered by the join re-ask in platform-api.
// Skipped where no platform-api is configured (the plain mock world) and when the interview is not in a call state.

import { decideRecording } from './recording-rules.js';
import { recordingServiceUrl, signedRecordingHeaders } from './retention/erasers.js';
import { interviewLobby } from './retention/rules.js';

export const RECORDING_DECISION_PATH = '/internal/recordings/interview-decision';
/** One try waits longer than platform-api's stop confirmation, and all the tries together stop at the budget. */
const PUSH_TIMEOUT_MS = 12_000;
const BUDGET_MS = 20_000;
/** A failed try (thrown, timed out or 5xx) is tried again this many times in all, waiting longer each time. */
const ATTEMPTS = 4;
const BACKOFF_MS = 500;

/** The decision's own read failed (the store), as opposed to platform-api's answer: tried again like a 5xx. */
class ReadFailed extends Error {
  constructor(cause: unknown) { super(`the decision could not be read (${cause instanceof Error ? cause.name : 'error'})`); }
}

export interface PushDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  warn: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

/** Answers true when platform-api accepted the decision, false when nothing was sent or it failed. */
export async function pushRecordingDecision(interviewId: string, deps: Partial<PushDeps> = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    const base = recordingServiceUrl(env);
    if (!base) return false;
    const lobbyName = interviewLobby(interviewId);
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;
    const started = now();
    for (let attempt = 1; ; attempt += 1) {
      // Every try decides afresh, and the version is read with the answer: a retry sends the row as it is now, never an old answer under a newer version.
      // A store that fails to read is tried again here, as a platform-api that fails to answer is.
      let failure: string;
      try {
        const decision = await decideRecording(lobbyName, async () => true, { storeErrors: 'throw' })
          .catch((err: unknown) => { throw new ReadFailed(err); });
        // A call that is not open has nothing to switch.
        if (decision.status !== 200 || decision.body.reason === 'interview-not-open') return false;
        const { record, transcribe, reason, decisionVersion } = decision.body;
        const body = { lobbyName, purpose: 'interview-decision', record, transcribe, reason, decisionVersion };
        const headers = signedRecordingHeaders(body, env);
        if (!headers) return false;
        const left = BUDGET_MS - (now() - started);
        const res = await (deps.fetch ?? fetch)(`${base}${RECORDING_DECISION_PATH}`, {
          method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.min(PUSH_TIMEOUT_MS, left))),
        });
        if (res.ok) break;
        if (res.status < 500) throw new Error(`answered ${res.status}`);
        failure = `answered ${res.status}`;
      } catch (err) {
        failure = err instanceof Error ? err.message : 'failed';
        if (/^answered 4/.test(failure)) throw err;
      }
      const wait = BACKOFF_MS * 2 ** (attempt - 1);
      if (attempt >= ATTEMPTS || now() - started + wait >= BUDGET_MS) throw new Error(`${failure} after ${attempt} tries`);
      await sleep(wait);
    }
    return true;
  } catch (err) {
    warn(`[interviews] recording decision not pushed: ${err instanceof Error ? err.message : 'failed'}`);
    return false;
  }
}
