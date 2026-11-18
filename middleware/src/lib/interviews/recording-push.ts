// A saved consent answer, pushed to platform-api while the interview's call may be live.
//
// POST /internal/recordings/interview-decision { lobbyName, record, transcribe, reason } switches recording on or off in a call that
// is already running. The values are the BFF's own D2 answer for the lobby (decideRecording), so the push and the /recording-decision
// route never disagree. Signed as the same service as the recording erase. Best effort: it never throws, and a failure is one warning.
// Skipped where no platform-api is configured (the plain mock world) and when the interview is not in a call state.

import { decideRecording } from './recording-rules.js';
import { recordingServiceUrl, signedRecordingHeaders } from './retention/erasers.js';
import { interviewLobby } from './retention/rules.js';

export const RECORDING_DECISION_PATH = '/internal/recordings/interview-decision';
const PUSH_TIMEOUT_MS = 8_000;
/** A 503 means platform-api could not confirm the switch: tried again this many times in all, waiting longer each time. */
const ATTEMPTS = 4;
const BACKOFF_MS = 500;

export interface PushDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  warn: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
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
    for (let attempt = 1; ; attempt += 1) {
      // Every try decides afresh, and the version is read with the answer: a retry sends the row as it is now, never an old answer under a newer version.
      const decision = await decideRecording(lobbyName, async () => true);
      // A call that is not open has nothing to switch.
      if (decision.status !== 200 || decision.body.reason === 'interview-not-open') return false;
      const { record, transcribe, reason, decisionVersion } = decision.body;
      const body = { lobbyName, purpose: 'interview-decision', record, transcribe, reason, decisionVersion };
      const headers = signedRecordingHeaders(body, env);
      if (!headers) return false;
      const res = await (deps.fetch ?? fetch)(`${base}${RECORDING_DECISION_PATH}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (res.ok) break;
      if (res.status !== 503 || attempt >= ATTEMPTS) throw new Error(`answered ${res.status}${res.status === 503 ? ` after ${attempt} tries` : ''}`);
      await sleep(BACKOFF_MS * 2 ** (attempt - 1));
    }
    return true;
  } catch (err) {
    warn(`[interviews] recording decision not pushed: ${err instanceof Error ? err.message : 'failed'}`);
    return false;
  }
}
