// Every mutation the Browser capability page makes, in one place.
//
// These were seven inline `fetch(...)` bodies spread across three tab
// components, each re-deriving "read the JSON, then decide whether it failed".
// They differ only in URL and payload, so the error handling now goes through
// the shared `sendJson` helper (portal/src/lib/writeJson.ts): a non-2xx
// response throws with the server's `error` field when it has one and
// `HTTP <status>` when it does not.

import { sendJson } from '../../../lib/writeJson';
import type { BrowserSession, JourneyStep, WebQAResult } from './types';

const SESSIONS = '/api/capabilities/browser-sessions';

/** Screenshot a page in a sandboxed Chrome and ask Nova Lite about it. */
export function askPage(url: string, question: string): Promise<WebQAResult> {
  return sendJson<WebQAResult>('/api/capabilities/browser/web-qa', 'POST', { url, question });
}

export async function launchSession(agentName: string, url?: string): Promise<BrowserSession> {
  const body = await sendJson<{ session?: BrowserSession }>(SESSIONS, 'POST', { agentName, url: url || undefined });
  if (!body.session?.sessionId) throw new Error('launch failed');
  return body.session;
}

/**
 * Navigate an open session.
 *
 * `captureScreenshot` is what puts a step in the journey ring — the launch
 * endpoint navigates but does not capture, which is why starting a journey has
 * to launch and then immediately navigate to the same URL.
 */
export function navigateSession(sessionId: string, url: string, captureScreenshot = true): Promise<JourneyStep> {
  return sendJson<JourneyStep>(`${SESSIONS}/${sessionId}/navigate`, 'POST', { url, captureScreenshot });
}

export async function closeSession(sessionId: string): Promise<void> {
  await sendJson(`${SESSIONS}/${sessionId}`, 'DELETE');
}

export const SESSIONS_URL = SESSIONS;

export const journeyUrl = (sessionId: string | null): string =>
  sessionId ? `${SESSIONS}/${sessionId}/journey` : '';
