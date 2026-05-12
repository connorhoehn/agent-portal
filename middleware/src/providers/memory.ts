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

export interface MemoryEvent {
  eventId: string;
  sessionId: string;
  timestamp: string;
  role: 'USER' | 'ASSISTANT' | 'OTHER';
  text: string;
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
        for (const p of ev.payload ?? []) {
          const conv = (p as any).conversational;
          if (!conv) continue;
          const role = String(conv.role ?? 'OTHER').toUpperCase() as MemoryEvent['role'];
          const text =
            conv.content?.text ??
            (typeof conv.content === 'string' ? conv.content : JSON.stringify(conv.content ?? '')) ??
            '';
          out.push({
            eventId: ev.eventId,
            sessionId,
            timestamp: (ev.eventTimestamp instanceof Date ? ev.eventTimestamp : new Date()).toISOString(),
            role: role === 'USER' || role === 'ASSISTANT' ? role : 'OTHER',
            text,
          });
        }
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
}): Promise<void> {
  const memoryId = config.agentcore.memoryId;
  if (!memoryId) return;
  if (!opts.userMessage.trim() || !opts.assistantMessage.trim()) return;
  try {
    await _client().send(
      new CreateEventCommand({
        memoryId,
        actorId: actorScope(opts),
        sessionId: opts.sessionId,
        eventTimestamp: new Date(),
        payload: [
          {
            conversational: {
              role: 'USER',
              content: { text: opts.userMessage },
            } as any,
          },
          {
            conversational: {
              role: 'ASSISTANT',
              content: { text: opts.assistantMessage },
            } as any,
          },
        ],
      }),
    );
  } catch (err) {
    // Don't fail the invocation if memory write fails — log and continue.
    console.warn('[memory] recordTurn failed:', (err as Error).message);
  }
}
