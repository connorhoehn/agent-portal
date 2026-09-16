// Every mutation the Browser capability page makes, in one place.
//
// These were seven inline `fetch(...)` bodies spread across three tab
// components, each re-deriving "read the JSON, then decide whether it failed".
// They differ only in URL and payload, so the error handling is now written
// once: a non-2xx response throws with the server's `error` field when it has
// one and `HTTP <status>` when it does not.

import type { BrowserSession, JourneyStep, WebQAResult } from './types';

const SESSIONS = '/api/capabilities/browser-sessions';

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(parsed.error ?? `HTTP ${res.status}`);
  return parsed;
}

/** Screenshot a page in a sandboxed Chrome and ask Nova Lite about it. */
export function askPage(url: string, question: string): Promise<WebQAResult> {
  return postJson<WebQAResult>('/api/capabilities/browser/web-qa', { url, question });
}

export async function launchSession(agentName: string, url?: string): Promise<BrowserSession> {
  const body = await postJson<{ session?: BrowserSession }>(SESSIONS, { agentName, url: url || undefined });
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
  return postJson<JourneyStep>(`${SESSIONS}/${sessionId}/navigate`, { url, captureScreenshot });
}

export async function closeSession(sessionId: string): Promise<void> {
  const res = await fetch(`${SESSIONS}/${sessionId}`, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
}

export const SESSIONS_URL = SESSIONS;

export const journeyUrl = (sessionId: string | null): string =>
  sessionId ? `${SESSIONS}/${sessionId}/journey` : '';
