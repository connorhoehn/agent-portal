// AgentCore Memory provider — persists conversation events to the deployed
// orgiq_memory resource so sessions survive page reloads / restarts.
//
// Model:
//   - actorId  = "portal-default" (single-tenant; would be a user ID once auth lands)
//   - sessionId = a UUID generated client-side, carried through invokes
//   - event     = one user message + one assistant message, written per turn
//
// AgentCore Memory also exposes "long-term memory" extracted from events via
// memory strategies, but we don't query that here — pure event store today.

import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListEventsCommand,
  ListSessionsCommand,
  type ListEventsCommandOutput,
  type ListSessionsCommandOutput,
} from '@aws-sdk/client-bedrock-agentcore';
import { config } from '../config.js';
import {
  decodeToolCalls,
  encodeToolCalls,
  isToolCallsPayload,
  type StoredToolCall,
} from '../lib/turn-tool-calls.js';

export type { StoredToolCall };

export interface MemoryEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  role: 'USER' | 'ASSISTANT' | 'OTHER';
  text: string;
  /**
   * Tool calls the assistant made on this turn — the provenance the portal
   * derives source chips and the tool summary from. Present on ASSISTANT
   * events written after tool-call persistence landed; absent on older ones,
   * which restore exactly as they did before (text, no chips).
   */
  toolCalls?: StoredToolCall[];
}

export interface MemorySession {
  sessionId: string;
  actorId: string;
  createdAt: string;
}

const _client = (): BedrockAgentCoreClient =>
  new BedrockAgentCoreClient({ region: config.region });

function actorScope(req?: { actorId?: string }): string {
  return req?.actorId || 'portal-default';
}

/**
 * Whether AgentCore Memory is configured at all.
 *
 * Exported so `routes/sessions.ts` can say WHY its list is empty without
 * importing `config.ts` — that module reaches `import.meta`, which is a hard
 * TS1343 parse error under this repo's ts-jest CJS transform, and importing it
 * into a route takes that route's whole test suite down with it (it did).
 * Every consumer already mocks this provider, so the fact travels with the
 * thing that owns it.
 */
export function memoryConfigured(): boolean {
  return Boolean(config.agentcore.memoryId);
}

export async function listSessions(actorId?: string): Promise<MemorySession[]> {
  const memoryId = config.agentcore.memoryId;
  if (!memoryId) return [];
  try {
    const out: MemorySession[] = [];
    let nextToken: string | undefined = undefined;
    do {
      const resp: ListSessionsCommandOutput = await _client().send(
        new ListSessionsCommand({
          memoryId,
          actorId: actorScope({ actorId }),
          maxResults: 50,
          nextToken,
        }),
      );
      for (const s of resp.sessionSummaries ?? []) {
        if (!s.sessionId) continue;
        out.push({
          sessionId: s.sessionId,
          actorId: s.actorId ?? actorScope({ actorId }),
          createdAt: (s.createdAt instanceof Date ? s.createdAt : new Date()).toISOString(),
        });
      }
      nextToken = resp.nextToken;
    } while (nextToken);
    // Newest first.
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (err) {
    console.warn('[memory] listSessions failed:', (err as Error).message);
    return [];
  }
}

export async function listEvents(sessionId: string, actorId?: string): Promise<MemoryEvent[]> {
  const memoryId = config.agentcore.memoryId;
  if (!memoryId) return [];
  try {
    const out: MemoryEvent[] = [];
    let nextToken: string | undefined = undefined;
    do {
      const resp: ListEventsCommandOutput = await _client().send(
        new ListEventsCommand({
          memoryId,
          sessionId,
          actorId: actorScope({ actorId }),
          includePayloads: true,
          maxResults: 100,
          nextToken,
        }),
      );
      for (const ev of resp.events ?? []) {
        if (!ev.eventId) continue;
        const ts = (ev.eventTimestamp instanceof Date ? ev.eventTimestamp : new Date()).toISOString();
        // One event holds the whole turn: the user message, the assistant
        // message, and (since tool-call persistence) a TOOL-role payload item
        // carrying the turn's provenance envelope. Collect the envelope first,
        // then attach it to this event's ASSISTANT message so the restored
        // shape matches what the live stream produces.
        const turn: MemoryEvent[] = [];
        let turnToolCalls: StoredToolCall[] | null = null;
        for (const p of ev.payload ?? []) {
          const conv = (p as any).conversational;
          if (!conv) continue;
          const role = String(conv.role ?? 'OTHER').toUpperCase() as MemoryEvent['role'];
          const text =
            conv.content?.text ??
            (typeof conv.content === 'string' ? conv.content : JSON.stringify(conv.content ?? '')) ??
            '';
          if (isToolCallsPayload(text)) {
            turnToolCalls = decodeToolCalls(text) ?? turnToolCalls;
            continue; // bookkeeping, not a message — never rendered as one
          }
          turn.push({
            eventId: ev.eventId,
            sessionId,
            timestamp: ts,
            role: role === 'USER' || role === 'ASSISTANT' ? role : 'OTHER',
            text,
          });
        }
        if (turnToolCalls) {
          for (const m of turn) {
            if (m.role === 'ASSISTANT') m.toolCalls = turnToolCalls;
          }
        }
        out.push(...turn);
      }
      nextToken = resp.nextToken;
    } while (nextToken);
    // Chronological order so the UI replays the conversation naturally.
    return out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  } catch (err) {
    console.warn('[memory] listEvents failed:', (err as Error).message);
    return [];
  }
}

export async function recordTurn(opts: {
  sessionId: string;
  actorId?: string;
  userMessage: string;
  assistantMessage: string;
  /**
   * The turn's tool calls, as observed on the AG-UI stream. Persisted as a
   * third TOOL-role payload item (capped — see lib/turn-tool-calls) so a
   * restored conversation carries the same provenance the live one showed.
   */
  toolCalls?: StoredToolCall[];
}): Promise<void> {
  const memoryId = config.agentcore.memoryId;
  if (!memoryId) return;
  if (!opts.userMessage.trim() || !opts.assistantMessage.trim()) return;
  const toolEnvelope = encodeToolCalls(opts.toolCalls);

  const conversation = [
    { conversational: { role: 'USER', content: { text: opts.userMessage } } as any },
    { conversational: { role: 'ASSISTANT', content: { text: opts.assistantMessage } } as any },
  ];
  const write = (payload: typeof conversation): Promise<unknown> =>
    _client().send(
      new CreateEventCommand({
        memoryId,
        actorId: actorScope(opts),
        sessionId: opts.sessionId,
        eventTimestamp: new Date(),
        payload,
      }),
    );

  try {
    await write(
      toolEnvelope
        ? [...conversation, { conversational: { role: 'TOOL', content: { text: toolEnvelope } } as any }]
        : conversation,
    );
  } catch (err) {
    // Provenance is an enrichment; the transcript is the thing. If the service
    // rejects the extra TOOL payload item (an oversized envelope, a memory
    // resource that will not take the role), retry with the conversation
    // alone rather than letting a chip cost the user their turn.
    if (toolEnvelope) {
      console.warn('[memory] recordTurn with tool calls failed, retrying without:', (err as Error).message);
      try {
        await write(conversation);
        return;
      } catch (retryErr) {
        console.warn('[memory] recordTurn retry failed:', (retryErr as Error).message);
        return;
      }
    }
    // Don't fail the invocation if memory write fails — log and continue.
    console.warn('[memory] recordTurn failed:', (err as Error).message);
  }
}
