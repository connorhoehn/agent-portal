// Chat session persistence — shared by every useAgentStream surface.
//
// The backend already persists every turn to AgentCore Memory and serves
// transcripts via GET /api/sessions/:id/events; the hook already supports
// historyFetch/loadHistory. This module supplies the two missing client
// pieces: a canonical history fetcher, and localStorage bookkeeping so a
// reload resumes the conversation instead of orphaning it.
//
// Keys are per-surface ('invoke', 'explore', …) so each page resumes its own
// last conversation independently.

import type { Message } from '@connorhoehnslalom/realtime-modules/agent-streaming/client';

const STORAGE_PREFIX = 'chat.session.';

interface MemoryEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  role: 'USER' | 'ASSISTANT' | 'OTHER';
  text: string;
}

/** Remove <thinking>…</thinking> blocks (and a dangling unclosed one). */
export function stripThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
    .replace(/<thinking>[\s\S]*$/, '')
    .trim();
}

/**
 * Canonical historyFetch for useAgentStream: pull the persisted transcript
 * from AgentCore Memory and map to hook messages.
 *
 * `keepThinking` controls whether assistant <thinking> blocks survive —
 * pass true only when the surface renders them (Invoke's ThinkingBlock).
 */
export async function fetchSessionMessages(
  sessionId: string,
  opts?: { keepThinking?: boolean },
): Promise<Message[]> {
  const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  if (!r.ok) return [];
  const body = (await r.json()) as { events: MemoryEvent[] };
  return body.events
    .filter(e => e.role === 'USER' || e.role === 'ASSISTANT')
    .map<Message>(e => ({
      id: `${e.eventId}:${e.role}`,
      role: e.role === 'USER' ? 'user' : 'assistant',
      content:
        e.role === 'ASSISTANT' && !opts?.keepThinking
          ? stripThinking(e.text)
          : e.text,
      toolCalls: [],
    }))
    .filter(m => m.content.length > 0);
}

/** Persist the surface's active sessionId so a reload can resume it. */
export function rememberSession(surface: string, sessionId: string): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + surface, sessionId);
  } catch { /* storage unavailable — resume just won't work */ }
}

/** The surface's last active sessionId, if any. */
export function recallSession(surface: string): string | null {
  try {
    return localStorage.getItem(STORAGE_PREFIX + surface);
  } catch {
    return null;
  }
}

/** Drop the remembered session (user explicitly started a new conversation). */
export function forgetSession(surface: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + surface);
  } catch { /* ignore */ }
}
