// A saved consent answer, pushed to platform-api while the interview's call may be live.
//
// POST /internal/recordings/interview-decision { lobbyName, record, transcribe, reason } switches recording on or off in a call that
// is already running. The values are the BFF's own D2 answer for the lobby (decideRecording), so the push and the /recording-decision
// route never disagree. Signed as the same service as the recording erase. Best effort: it never throws, and a failure is one warning.
// Skipped where no platform-api is configured (the plain mock world) and when the interview is not in a call state.

import { SERVICE_AUTH_HEADER, signEnvelope } from '@connorhoehn/service-runtime';
import { decideRecording } from './recording-rules.js';
import { recordingServiceUrl } from './retention/erasers.js';
import { interviewLobby } from './retention/rules.js';

export const RECORDING_DECISION_PATH = '/internal/recordings/interview-decision';
const PUSH_TIMEOUT_MS = 8_000;

export interface PushDeps {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
  warn: (message: string) => void;
}

/** Answers true when platform-api accepted the decision, false when nothing was sent or it failed. */
export async function pushRecordingDecision(interviewId: string, deps: Partial<PushDeps> = {}): Promise<boolean> {
  const env = deps.env ?? process.env;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  try {
    const base = recordingServiceUrl(env);
    if (!base) return false;
    const secret = env['SERVICE_AUTH_SECRET']?.trim();
    if (!secret) return false;
    const lobbyName = interviewLobby(interviewId);
    const decision = await decideRecording(lobbyName, async () => true);
    // A call that is not open has nothing to switch.
    if (decision.status !== 200 || decision.body.reason === 'interview-not-open') return false;
    const serviceId = env['RECORDING_ERASE_SERVICE_ID']?.trim() || 'aws-agentcore';
    const body = { lobbyName, record: decision.body.record, transcribe: decision.body.transcribe, reason: decision.body.reason };
    const res = await (deps.fetch ?? fetch)(`${base}${RECORDING_DECISION_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SERVICE_AUTH_HEADER]: signEnvelope(body, { secret, serviceId }) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`answered ${res.status}`);
    return true;
  } catch (err) {
    warn(`[interviews] recording decision not pushed: ${err instanceof Error ? err.message : 'failed'}`);
    return false;
  }
}
