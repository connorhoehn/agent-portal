// Pure naming and mapping for the pipelines tenant's realtime surfaces. The
// BFF gateway admits only `<tenant>:` channels (middleware channelGuard), so
// every channel here carries the `pipelines:` prefix.

export const runChannel = (runId: string): string => `pipelines:run:${runId}`;
export const defChannel = (definitionId: string): string => `pipelines:def:${definitionId}`;

import { isConnected } from '../../components/chat/chatConnection.ts';
export { isConnected };

interface RosterEntry { clientId: string; status?: string; metadata?: Record<string, unknown> }

/** One avatar per person, not per connection (a second tab must not read as a second viewer). */
export function rosterUsers(roster: ReadonlyArray<RosterEntry>): Array<{ id: string; name: string; idle?: boolean; avatarUrl?: string }> {
  const byUser = new Map<string, { id: string; name: string; idle: boolean; avatarUrl?: string }>();
  for (const entry of roster) {
    const meta = entry.metadata ?? {};
    const userId = typeof meta['userId'] === 'string' && meta['userId'] ? meta['userId'] : entry.clientId;
    const name = [meta['displayName'], meta['name'], meta['userId']].find((v): v is string => typeof v === 'string' && v.length > 0) ?? entry.clientId.slice(0, 8);
    const idle = !!entry.status && entry.status !== 'online';
    const avatarUrl = typeof meta['avatarUrl'] === 'string' && meta['avatarUrl'] ? meta['avatarUrl'] : undefined;
    const seen = byUser.get(userId);
    if (seen) { seen.idle = seen.idle && idle; seen.avatarUrl ??= avatarUrl; }
    else byUser.set(userId, { id: userId, name, idle, ...(avatarUrl ? { avatarUrl } : {}) });
  }
  return [...byUser.values()].map(({ id, name, idle, avatarUrl }) => ({ id, name, ...(idle ? { idle: true } : {}), ...(avatarUrl ? { avatarUrl } : {}) }));
}

/** The wire channel the library's `client/pipelines` hook subscribes; the gateway maps it onto `runChannel`. */
export const runWireChannel = (runId: string): string => `pipeline:run:${runId}`;

/** Where a run's event stream comes from: the gateway while it is connected, the BFF's SSE only when it is not. */
export function eventsSource(connectionState: string | null | undefined): 'gateway' | 'sse' {
  return isConnected(connectionState) ? 'gateway' : 'sse';
}

/** A live phase change is the cue to re-read the durable run; the first sight of a phase is not (the page just read it). */
export function phaseMoved(previous: string | undefined, next: string | undefined): boolean {
  return !!next && !!previous && previous !== next;
}

const PHASE_STATUSES: Record<string, readonly string[]> = {
  received: ['pending'],
  running: ['running', 'paused_at_breakpoint', 'stuck'],
  awaiting_approval: ['awaiting_approval'],
  completed: ['completed', 'cancelled'],
  failed: ['failed'],
  rejected: ['rejected'],
};

/** Does the run record the page holds disagree with a live phase? (A frame that is the FIRST one seen still counts: the record may be older than it.) */
export function recordBehind(recordedStatus: string | undefined, phase: string | undefined): boolean {
  if (!phase || !recordedStatus) return false;
  const known = PHASE_STATUSES[phase];
  return !!known && !known.includes(recordedStatus);
}
