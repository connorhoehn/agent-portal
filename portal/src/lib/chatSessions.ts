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

import type { Message, ToolCall } from '@connorhoehn/realtime-modules/agent-streaming/client';

const STORAGE_PREFIX = 'chat.session.';

/** One persisted tool call, as `GET /api/sessions/:id/events` returns it. */
interface StoredToolCall {
  id?: string;
  name: string;
  args?: string;
  result?: string;
  /** The middleware capped this result to fit the event (see turn-tool-calls). */
  truncated?: boolean;
}

interface MemoryEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  role: 'USER' | 'ASSISTANT' | 'OTHER';
  text: string;
  toolCalls?: StoredToolCall[];
}

/**
 * A history load that did not happen — as distinct from a conversation with
 * nothing in it. `fetchSessionMessages` throws this rather than returning `[]`,
 * because the two used to render identically: an expired cookie or a 500 on
 * auto-resume presented as "your conversation is gone".
 */
export class SessionHistoryError extends Error {
  readonly status: number | undefined;
  /** True when the fix is to sign in again, not to retry. */
  readonly needsAuth: boolean;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SessionHistoryError';
    this.status = status;
    this.needsAuth = status === 401 || status === 403;
  }
}

function historyErrorFor(status: number): SessionHistoryError {
  if (status === 401) return new SessionHistoryError('Your session expired — sign in to load this conversation.', status);
  if (status === 403) return new SessionHistoryError('You do not have access to this conversation.', status);
  if (status === 404) return new SessionHistoryError('That conversation is no longer stored.', status);
  return new SessionHistoryError(`Could not load this conversation (HTTP ${status}).`, status);
}

/**
 * Rebuild the live stream's `toolCalls` shape from what was stored.
 *
 * The portal derives source chips (`deriveSources`) and the tool-summary line
 * (`summarizeToolCalls`) from `message.toolCalls`, so this is the whole of a
 * restored turn's provenance. `done: true` because a persisted call is by
 * definition finished; `args` defaults to '' to match `ToolCall`.
 */
function restoreToolCalls(stored: StoredToolCall[] | undefined, key: string): ToolCall[] {
  if (!Array.isArray(stored)) return [];
  return stored
    .filter((tc) => tc && typeof tc.name === 'string' && tc.name.length > 0)
    .map((tc, i) => ({
      id: tc.id ?? `${key}:tool:${i}`,
      name: tc.name,
      args: tc.args ?? '',
      ...(tc.result !== undefined ? { result: tc.result } : {}),
      done: true,
    }));
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
 *
 * Throws `SessionHistoryError` when the transcript could not be loaded. It
 * used to `return []`, which told the caller "this conversation is empty" —
 * the one thing it could not know. Auto-resume runs this on mount, so an
 * expired cookie wiped the visible conversation with no explanation.
 */
export async function fetchSessionMessages(
  sessionId: string,
  opts?: { keepThinking?: boolean },
): Promise<Message[]> {
  let r: Response;
  try {
    r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/events`, { credentials: 'include' });
  } catch {
    throw new SessionHistoryError('Could not reach the server to load this conversation.');
  }
  if (!r.ok) throw historyErrorFor(r.status);

  let body: { events: MemoryEvent[] };
  try {
    body = (await r.json()) as { events: MemoryEvent[] };
  } catch {
    throw new SessionHistoryError('The stored conversation could not be read.');
  }
  if (!Array.isArray(body?.events)) {
    throw new SessionHistoryError('The stored conversation could not be read.');
  }

  return body.events
    .filter(e => e.role === 'USER' || e.role === 'ASSISTANT')
    .map<Message>(e => {
      const id = `${e.eventId}:${e.role}`;
      return {
        id,
        role: e.role === 'USER' ? 'user' : 'assistant',
        content:
          e.role === 'ASSISTANT' && !opts?.keepThinking
            ? stripThinking(e.text)
            : e.text,
        // Provenance persisted with the turn — same shape the live stream
        // builds, so the chat components render a reopened turn identically.
        toolCalls: restoreToolCalls(e.toolCalls, id),
      };
    })
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
