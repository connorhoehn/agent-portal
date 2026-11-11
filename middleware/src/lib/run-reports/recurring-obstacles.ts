// Obstacles that runs keep hitting (docs/value-sweep-2026-11-11.md package 6). A run report stores
// its obstacles as plain sentences, one list per report, with no kind or code, so the only
// grouping available is plain equality of normalised text: no model, no embeddings (decisions 6
// and 17). A group is the same sentence, in the same repository (or, where the repository is not
// known, the same initiative), seen in two or more different runs inside the window. Pure.
import type { RunReport } from './types.js';

export interface RecurringObstacle {
  /** Stable within one answer: the scope and the normalised text. */
  key: string;
  /** The wording of the most recent run that said it. */
  text: string;
  scope: { kind: 'repo' | 'initiative'; ref: string };
  /** Different runs that hit it. */
  runs: number;
  /** Different work items among those runs (a run with no work item counts none). */
  workItems: number;
  /** How many of those runs ended failed. */
  failedRuns: number;
  firstSeen: string;
  lastSeen: string;
  /** The most recent five, newest first. */
  runRefs: string[];
  /** The initiatives the runs belong to (a repository can hold several). */
  initiativeIds: string[];
}

export interface RecurringObstacleOptions {
  /** The repository an initiative works in, when known; a group is by repository when it is. */
  repoOf?: (initiativeId: string) => string | null | undefined;
  /** Keep only groups in this repository (compared by basename) or this initiative. */
  repo?: string;
  initiativeId?: string;
}

/** Case, whitespace and punctuation folded away; digits and letters kept. "The CSRF gate failed." and "the csrf gate  failed" meet. */
export function normaliseObstacle(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const baseName = (repo: string): string => repo.replace(/\.git$/, '').split('/').pop()!.toLowerCase();

export function groupRecurringObstacles(reports: readonly RunReport[], opts: RecurringObstacleOptions = {}): RecurringObstacle[] {
  interface Acc { text: string; textAt: string; scope: RecurringObstacle['scope']; runs: Map<string, RunReport>; }
  const groups = new Map<string, Acc>();
  for (const r of reports) {
    if (!r.initiativeId) continue;
    const repo = opts.repoOf?.(r.initiativeId) ?? null;
    if (opts.initiativeId && r.initiativeId !== opts.initiativeId) continue;
    if (opts.repo && (!repo || baseName(repo) !== baseName(opts.repo))) continue;
    const scope: RecurringObstacle['scope'] = repo ? { kind: 'repo', ref: repo } : { kind: 'initiative', ref: r.initiativeId };
    for (const text of r.obstacles ?? []) {
      const norm = normaliseObstacle(text);
      if (!norm) continue;
      const key = `${scope.kind}:${scope.kind === 'repo' ? baseName(scope.ref) : scope.ref}:${norm}`;
      let g = groups.get(key);
      if (!g) { g = { text, textAt: r.endedAt, scope, runs: new Map(), }; groups.set(key, g); }
      if (r.endedAt > g.textAt) { g.text = text; g.textAt = r.endedAt; }
      g.runs.set(r.runRef, r);
    }
  }
  const out: RecurringObstacle[] = [];
  for (const [key, g] of groups) {
    if (g.runs.size < 2) continue;
    const rs = [...g.runs.values()].sort((a, b) => b.endedAt.localeCompare(a.endedAt) || a.runRef.localeCompare(b.runRef));
    out.push({
      key, text: g.text, scope: g.scope,
      runs: rs.length,
      workItems: new Set(rs.map((r) => r.workItemId).filter((x): x is string => !!x)).size,
      failedRuns: rs.filter((r) => r.outcome === 'failed').length,
      firstSeen: rs[rs.length - 1]!.endedAt,
      lastSeen: rs[0]!.endedAt,
      runRefs: rs.slice(0, 5).map((r) => r.runRef),
      initiativeIds: [...new Set(rs.map((r) => r.initiativeId!))].sort(),
    });
  }
  return out.sort((a, b) => b.runs - a.runs || b.lastSeen.localeCompare(a.lastSeen) || a.key.localeCompare(b.key));
}
