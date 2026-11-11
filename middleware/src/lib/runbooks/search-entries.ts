// The runbook rows the org search projects as its "knowledge" documents: the
// published runbooks, each with the title and summary of its current version.
// Read-only; the store is injectable so a suite can hand it a private one.
import { runbookStore } from './store-select.js';
import type { RunbookStore } from './store.js';
import type { Runbook, RunbookDoc, RunbookScope } from './types.js';

export interface RunbookSearchEntry {
  id: string;
  title: string;
  summary: string;
  /** The words of the current version past its title and summary: when to use it, steps, failure modes, notes. Commands are left out. */
  body: string;
  scope: RunbookScope;
  status: Runbook['status'];
  version: number;
  updated_at: string;
  /** Initiative id when the runbook is scoped to one. */
  initiative_id: string | null;
}

const BODY_CHARS = 6000;

/** The prose of a runbook version, flattened for search. */
export function runbookBodyText(d: RunbookDoc): string {
  const parts = [
    ...d.use_when, ...d.not_for, ...d.preconditions,
    ...d.steps.flatMap((x) => [x.do, x.expect ?? '', x.why ?? '']),
    ...d.verify.map((x) => x.check),
    ...d.failure_modes.flatMap((x) => [x.symptom, x.cause, x.response]),
    ...d.rollback.map((x) => x.do),
    d.notes ?? '',
  ];
  return parts.map((x) => (x ?? '').trim()).filter(Boolean).join(' ').slice(0, BODY_CHARS);
}

async function entryOf(store: RunbookStore, r: Runbook): Promise<RunbookSearchEntry | null> {
  if (r.status !== 'published') return null;
  const v = await store.getVersion(r.id, r.current_version);
  if (!v) return null;
  return {
    id: r.id, title: v.doc.title, summary: v.doc.summary, body: runbookBodyText(v.doc), scope: r.scope, status: r.status,
    version: r.current_version, updated_at: r.updated_at,
    initiative_id: r.scope.kind === 'initiative' ? r.scope.ref : null,
  };
}

export async function listRunbookSearchEntries(store: RunbookStore = runbookStore()): Promise<RunbookSearchEntry[]> {
  const out: RunbookSearchEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listRunbooks({ status: ['published'], cursor, limit: 200 });
    for (const r of page.items) { const e = await entryOf(store, r); if (e) out.push(e); }
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
}

export async function getRunbookSearchEntry(id: string, store: RunbookStore = runbookStore()): Promise<RunbookSearchEntry | null> {
  const r = await store.getRunbook(id);
  return r ? entryOf(store, r) : null;
}
