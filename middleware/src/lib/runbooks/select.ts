// Which runbooks a run is given (design §3.2) — deterministic and pure.
//
//   1. Candidates: published runbooks whose scope matches the run — repo = the
//      work item's repo, initiative = its initiative, tool = named in its
//      labels/title/description, org always. Draft and retired never.
//   2. Pinned first: a runbook a person attached to the work item is always
//      a candidate (if published) and ordered first, in pin order.
//   3. Score: scope specificity (repo 3, initiative 2, tool 2, org 1)
//      + 2 × label hits (triggers.work_item_labels ∩ labels, plus the work
//      item's repo named in triggers.repos)
//      + 3 × keyword Jaccard(work item title + description,
//                            runbook title + use_when + keywords + tools)
//      + health (proven +1, unproven 0, drifting −1).
//      Dropped: keyword Jaccard 0 with no pin and no label hit.
//   4. Order: pinned, then score descending, then id.
//
// The budget (whole runbooks, at most MAX_GIVEN_RUNBOOKS) is assembleBrief's
// job; this returns every eligible runbook in order. lib/run-brief.ts calls it
// once per brief, with the work item's pins (docs/learning-loop-design.md stage 4).
import type { Runbook, RunbookHealth, RunbookVersion } from './types.js';
import { round4, sharedTokens, similarity, tokens } from './similarity.js';

export interface WorkItemContext {
  id: string;
  title: string;
  description: string;
  labels: string[];
  /** "connorhoehn/orgiq-auth-service" or "orgiq-auth-service"; compared by basename. */
  repo: string | null;
  initiative_id: string | null;
  /** Runbooks a person attached to the work item, in their order. */
  pinned_runbook_ids: string[];
}

export interface RunbookCandidate {
  runbook: Runbook;
  /** The version to hand out — normally runbook.current_version. */
  version: RunbookVersion;
  health: RunbookHealth;
}

export interface SelectedRunbook {
  runbook_id: string;
  version: number;
  title: string;
  /** The version's stored canonical markdown, embedded verbatim in a brief. */
  markdown: string;
  pinned: boolean;
  score: number;
  /** Why it was picked, in words: "pinned on the work item", "initiative p-auth-migration", "labels runbook, decom", "keywords tenant, cutover". */
  reasons: string[];
  health: RunbookHealth;
}

export interface Selection {
  selected: SelectedRunbook[];
  excluded: Array<{ runbook_id: string; reason: 'status' | 'scope' | 'no_match' }>;
}

export const SCOPE_WEIGHT = { repo: 3, initiative: 2, tool: 2, org: 1 } as const;

/** At most this many runbooks are given to a run as text (docs/learning-loop-design.md stage 4). */
export const MAX_GIVEN_RUNBOOKS = 2;

/**
 * The selector's reasons as one phrase a person reads on the brief and its preview: the
 * strongest signal first, no record ids ("labels decom, runbook; shares tenant, cutover; on
 * this initiative"). Pure.
 */
export function readableReason(reasons: readonly string[]): string {
  const rank = (r: string): number =>
    r === 'pinned on the work item' ? 0 : r.startsWith('labels ') ? 1 : r.startsWith('keywords ') ? 2
      : r.startsWith('triggers on repo ') ? 3 : 4;
  const phrase = (r: string): string => {
    if (r.startsWith('keywords ')) return `shares ${r.slice('keywords '.length)}`;
    if (r.startsWith('triggers on repo ')) return `written for repo ${r.slice('triggers on repo '.length)}`;
    if (r.startsWith('initiative ')) return 'on this initiative';
    if (r.startsWith('repo ')) return `scoped to repo ${r.slice('repo '.length)}`;
    if (r.startsWith('tool ')) return `the work names ${r.slice('tool '.length)}`;
    if (r === 'org-wide') return 'org-wide';
    return r;
  };
  // "written for repo X" already says what "scoped to repo X" would.
  const triggered = new Set(reasons.filter((r) => r.startsWith('triggers on repo ')).map((r) => r.slice('triggers on repo '.length)));
  return [...reasons].filter((r) => !(r.startsWith('repo ') && triggered.has(r.slice('repo '.length))))
    .sort((a, b) => rank(a) - rank(b)).map(phrase).join('; ');
}

/**
 * Why a selection gave nothing, in words. `considered` is how many published runbooks were
 * candidates at all. Pure.
 */
export function noneReason(selection: Selection, considered: number): string {
  if (considered === 0) return 'The library has no published runbooks yet.';
  const inScope = selection.excluded.filter((e) => e.reason === 'no_match').length;
  if (inScope === 1) return "The one runbook in this work's scope shares no label and no term with it.";
  if (inScope > 1) return `None of the ${inScope} runbooks in this work's scope shares a label or a term with it.`;
  return 'No published runbook is scoped to this work (its repository, its initiative, a tool it names, or the whole org).';
}
const HEALTH_WEIGHT = { proven: 1, unproven: 0, drifting: -1 } as const;

const base = (repo: string | null | undefined) => (repo ? repo.replace(/\.git$/, '').split('/').pop()!.toLowerCase() : '');
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function toolNamed(tool: string, work: Pick<WorkItemContext, 'title' | 'description' | 'labels'>): boolean {
  const t = tool.toLowerCase();
  if (work.labels.some((l) => l.toLowerCase() === t)) return true;
  const words = new Set(`${work.title} ${work.description}`.toLowerCase().split(/[^a-z0-9-]+/));
  return words.has(t);
}

/**
 * Does a runbook's scope admit this work? The reason in the selector's words ("org-wide",
 * "repo orgiq-auth-service", "initiative p-auth-migration", "tool jest"), or null. The pins
 * route asks the same question before it stores a pin.
 */
export function scopeMatch(scope: Runbook['scope'], work: Pick<WorkItemContext, 'title' | 'description' | 'labels' | 'repo' | 'initiative_id'>): string | null {
  const { kind, ref } = scope;
  if (kind === 'org') return 'org-wide';
  if (kind === 'repo' && ref && work.repo && base(ref) === base(work.repo)) return `repo ${base(ref)}`;
  if (kind === 'initiative' && ref && ref === work.initiative_id) return `initiative ${ref}`;
  if (kind === 'tool' && ref && toolNamed(ref, work)) return `tool ${ref}`;
  return null;
}

export function selectRunbooks(work: WorkItemContext, candidates: readonly RunbookCandidate[]): Selection {
  const excluded: Selection['excluded'] = [];
  const picked: SelectedRunbook[] = [];
  const workTerms = tokens(`${work.title} ${work.description}`);
  const labels = new Set(work.labels.map((l) => l.toLowerCase()));
  const pinIndex = new Map(work.pinned_runbook_ids.map((id, k) => [id, k]));

  for (const c of [...candidates].sort((a, b) => cmp(a.runbook.id, b.runbook.id))) {
    const rb = c.runbook;
    if (rb.status !== 'published') { excluded.push({ runbook_id: rb.id, reason: 'status' }); continue; }
    const pinned = pinIndex.has(rb.id);
    const reasons: string[] = [];
    if (pinned) reasons.push('pinned on the work item');

    const scope = scopeMatch(rb.scope, work);
    const scopeScore = scope ? SCOPE_WEIGHT[rb.scope.kind] : 0;
    if (scope) reasons.push(scope);
    if (scopeScore === 0 && !pinned) { excluded.push({ runbook_id: rb.id, reason: 'scope' }); continue; }

    const doc = c.version.doc;
    const labelHits = doc.triggers.work_item_labels.filter((l) => labels.has(l.toLowerCase()));
    const repoHit = work.repo !== null && doc.triggers.repos.some((r) => base(r) === base(work.repo));
    if (labelHits.length > 0) reasons.push(`labels ${labelHits.join(', ')}`);
    if (repoHit) reasons.push(`triggers on repo ${base(work.repo)}`);

    const rbTerms = tokens([doc.title, ...doc.use_when, ...doc.triggers.keywords, ...doc.triggers.tools].join(' '));
    const jac = similarity(workTerms, rbTerms);
    if (jac > 0) reasons.push(`keywords ${sharedTokens(workTerms, rbTerms).slice(0, 5).join(', ')}`);

    const hits = labelHits.length + (repoHit ? 1 : 0);
    // No label hit and no shared term: not given (docs/learning-loop-design.md stage 4). A repo
    // trigger alone is not a reason — it would hand every task in that repo the same runbook.
    if (jac === 0 && !pinned && labelHits.length === 0) { excluded.push({ runbook_id: rb.id, reason: 'no_match' }); continue; }

    const score = round4(scopeScore + 2 * hits + 3 * jac + HEALTH_WEIGHT[c.health.status]);
    picked.push({
      runbook_id: rb.id, version: c.version.version, title: doc.title, markdown: c.version.markdown,
      pinned, score, reasons, health: c.health,
    });
  }

  picked.sort((a, b) => {
    const pa = pinIndex.get(a.runbook_id), pb = pinIndex.get(b.runbook_id);
    if (pa !== undefined || pb !== undefined) {
      if (pa === undefined) return 1;
      if (pb === undefined) return -1;
      if (pa !== pb) return pa - pb;
    }
    return b.score - a.score || cmp(a.runbook_id, b.runbook_id);
  });
  return { selected: picked, excluded: excluded.sort((a, b) => cmp(a.runbook_id, b.runbook_id)) };
}
