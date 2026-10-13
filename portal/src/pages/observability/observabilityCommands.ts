// The bounded table commands for the admin observability detail pages
// (Runs, Capability Events, Tool Calls, Agent Metrics, Sessions, Access log,
// Memory, Guardrails, Approvals, Model Compare). Each grammar maps to the
// toolbar state its page already shows — search, at most one filter, refresh
// and an exact-record open — through the one shared parser in
// components/collections/collectionCommands.ts. Nothing here mutates data,
// records a decision or hands text to an agent.
import type { CollectionGrammar } from '../../components/collections/collectionCommands.ts';

export type ObservabilityCollection =
  | 'runs' | 'capabilityEvents' | 'tools' | 'agents' | 'sessions'
  | 'authz' | 'memory' | 'guardrails' | 'approvals' | 'modelCompare';

/** Filters name only values the page's own toolbar offers. */
export const OBSERVABILITY_GRAMMARS: Record<ObservabilityCollection, CollectionGrammar> = {
  runs: { noun: 'runs', filters: { ok: 'ok', blocked: 'blocked', errored: 'error' } },
  capabilityEvents: { noun: 'capability events', filters: { browser: 'browser', code: 'code' } },
  tools: { noun: 'tools', filters: { failing: 'failing' } },
  agents: { noun: 'agents' },
  sessions: { noun: 'sessions' },
  authz: { noun: 'decisions', filters: { allowed: 'ALLOW', denied: 'DENY' } },
  memory: { noun: 'memory events', filters: { retrieve: 'retrieve', write: 'write', summarize: 'summarize', expire: 'expire' } },
  guardrails: { noun: 'guardrails', extra: ['group by rule', 'group by person'] },
  approvals: { noun: 'approvals' },
  modelCompare: { noun: 'tests' },
};

/** Case-insensitive substring over the given fields; an empty query matches everything. */
export function matchesAny(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((field) => (field ?? '').toLowerCase().includes(q));
}

// Exact-open targets. An `open` resolves only an ID or a title that a reader
// can see in the current, filtered table; see resolveCollectionTarget.

export function invocationTarget(inv: { id: string }) {
  return { id: inv.id, title: inv.id };
}
export function sessionTarget(s: { sessionId: string; title?: string }) {
  return { id: s.sessionId, title: s.title ?? s.sessionId };
}
export function memoryEventTarget(e: { memoryEventId: string }) {
  return { id: e.memoryEventId, title: e.memoryEventId };
}
export function guardrailRuleTarget(r: { ruleName: string }) {
  return { id: r.ruleName, title: r.ruleName };
}
export function approvalTarget(a: { approvalId: string; txId: string }) {
  return { id: a.approvalId, title: a.txId };
}
