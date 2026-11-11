// Assemble a session brief WITHOUT freezing it: the one assembly path every
// brief takes (docs/learning-loop-design.md stage 4). It gathers the published
// runbooks, selects with the work item's pins first (lib/runbooks/select.ts),
// and assembles with the previous attempts the caller read; it never calls
// putBrief. lib/run-brief.ts `planRunBrief` is its only caller: the freeze and
// the work item's brief preview both go through that, so a preview and the
// brief a run receives differ only in what the run ref, the clock and the
// fence token make differ.
//
// The preview's run_ref is `preview-<work item id>`, so its id can never
// collide with a real run's.
import type { RunbookStore } from './runbooks/store.js';
import {
  assembleBrief, briefBudget, runbookHealth, loadSkillLibrary, noneReason, selectRunbooks, BOX_SKILLS_DIR,
  type BriefDecision, type BriefPreviousAttempt, type BriefSkillLibrary, type RunbookCandidate, type SessionBrief, type WorkItemContext,
} from './runbooks/index.js';

export interface PreviewWork {
  id: string;
  title: string;
  description: string | null;
  type: string;
  storyPoints: number | null;
  labels: string[];
  parentId: string | null;
  /** Runbooks a person pinned to the work item, in their order (work_items.runbook_pins). */
  runbookPins?: string[];
}
export interface PreviewProject { id: string; name: string; repoFullName: string | null }
export interface PreviewDecision { id: string; topic: string; summary: string | null; status: string }

export async function loadCandidates(store: RunbookStore, nowMs: number): Promise<RunbookCandidate[]> {
  const out: RunbookCandidate[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.listRunbooks({ status: ['published'], limit: 200, ...(cursor ? { cursor } : {}) });
    for (const runbook of page.items) {
      const version = await store.getVersion(runbook.id, runbook.current_version);
      if (!version) continue;
      const apps = await store.listApplications(runbook.id, runbook.current_version);
      out.push({ runbook, version, health: runbookHealth(apps, runbook.current_version, nowMs) });
    }
    cursor = page.next ?? undefined;
  } while (cursor);
  return out;
}

function decisionLine(d: PreviewDecision): BriefDecision {
  return { id: d.id, title: d.topic, status_line: `${d.status}${d.summary ? `: ${d.summary}` : ''}`, at: '' };
}

/** The org's skill library as a brief records it: its sha, where this box installs it, every skill's version. */
async function libraryOf(store: RunbookStore, dir: string | null): Promise<BriefSkillLibrary> {
  const lib = await loadSkillLibrary(store);
  return { sha256: lib.sha256, dir, skills: lib.skills.map((k) => ({ name: k.name, version: k.version })) };
}

/** What selection reads: the work item, or with no work item a job's title and prompt. Null: nothing to match. */
function selectionContext(input: {
  run_ref: string; work: PreviewWork | null; project: PreviewProject | null; repo: string | null;
  pinned: string[]; task: { title: string; text: string } | null;
}): WorkItemContext | null {
  const base = { repo: input.repo, initiative_id: input.project?.id ?? null };
  if (input.work) {
    return {
      ...base, id: input.work.id, title: input.work.title, description: input.work.description ?? '',
      labels: input.work.labels, pinned_runbook_ids: input.pinned,
    };
  }
  if (input.task) return { ...base, id: input.run_ref, title: input.task.title, description: input.task.text, labels: [], pinned_runbook_ids: [] };
  return null;
}

/** An in-scope runbook the selector or the brief's budget passed over, with a reason a person reads. */
export interface PassedOverRunbook {
  id: string;
  name: string;
  kind: 'no_match' | 'limit' | 'budget' | 'drifting_excluded';
  reason: string;
}

const PASSED_OVER_REASON: Record<PassedOverRunbook['kind'], string> = {
  no_match: 'In scope for this work, but it shares no label and no term with it.',
  limit: 'It matched, but two other runbooks ranked higher and at most two are given.',
  budget: 'It matched, but it did not fit whole in the brief’s token budget.',
  drifting_excluded: 'It matched, but recent runs have stumbled on it, so it was left out.',
};

/**
 * The in-scope runbooks that were not given: those that shared nothing with the work, and those
 * that matched but lost on the two-runbook limit or the budget. Out-of-scope runbooks are never
 * listed. Pure; ordered with the near misses (matched, then lost) first, then by name.
 */
export function passedOverRunbooks(
  selection: { excluded: ReadonlyArray<{ runbook_id: string; reason: string }> },
  omitted: ReadonlyArray<{ runbook_id: string; reason: string }>,
  candidates: readonly RunbookCandidate[],
): PassedOverRunbook[] {
  const names = new Map(candidates.map((c) => [c.runbook.id, c.version.doc.title]));
  const out: PassedOverRunbook[] = [];
  const seen = new Set<string>();
  const push = (id: string, kind: PassedOverRunbook['kind']) => {
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, name: names.get(id) ?? id, kind, reason: PASSED_OVER_REASON[kind] });
  };
  for (const o of omitted) {
    if (o.reason === 'limit' || o.reason === 'budget' || o.reason === 'drifting_excluded') push(o.runbook_id, o.reason);
  }
  const lost = out.length;
  for (const e of selection.excluded) if (e.reason === 'no_match') push(e.runbook_id, 'no_match');
  return [...out.slice(0, lost), ...out.slice(lost).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))];
}

export async function previewBrief(input: Parameters<typeof previewBriefWithPassedOver>[0]): Promise<SessionBrief> {
  return (await previewBriefWithPassedOver(input)).brief;
}

export async function previewBriefWithPassedOver(input: {
  store: RunbookStore;
  work: PreviewWork | null;
  parent: { title: string } | null;
  project: PreviewProject | null;
  decisions: PreviewDecision[];
  /** Runbook ids a person pinned to the work item, in order; always first when published. */
  pinned: string[];
  nowIso: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `preview-<work item id>`. */
  run_ref?: string;
  /** A job with no work item: its title and prompt are what selection reads. */
  task?: { title: string; text: string } | null;
  /** Overrides the project's repo (a governed run's checkout). */
  repo?: string | null;
  /**
   * R8: where this run's box installs the org's skill library — `~/.claude/skills` on a devbox
   * (the default), null on a machine that does not sync it (a local worker).
   */
  skillsDir?: string | null;
  /** Earlier attempts at this work item, newest first (lib/run-brief.ts previousAttempts). */
  previousAttempts?: BriefPreviousAttempt[];
  /** The fence token for this brief (random per freeze and per preview). */
  fenceToken?: string;
}): Promise<{ brief: SessionBrief; passedOver: PassedOverRunbook[] }> {
  const { work, project } = input;
  const runRef = input.run_ref ?? `preview-${work?.id ?? 'task'}`;
  const repo = input.repo ?? project?.repoFullName ?? null;
  const candidates = await loadCandidates(input.store, Date.parse(input.nowIso));
  const ctx = selectionContext({ run_ref: runRef, work, project, repo, pinned: input.pinned, task: input.task ?? null });
  const selection = ctx ? selectRunbooks(ctx, candidates) : { selected: [], excluded: [] };
  const brief = await assembleBrief({
    run_ref: runRef,
    assembled_at: input.nowIso,
    framing: '',
    work_item: work
      ? {
        id: work.id, title: work.title, kind: work.type, points: work.storyPoints,
        description: work.description ?? '', labels: work.labels,
        parent_epic: input.parent ? { title: input.parent.title } : null,
      }
      : null,
    initiative: project ? { id: project.id, name: project.name, repo: project.repoFullName } : null,
    repo,
    decisions: input.decisions.map(decisionLine),
    runbooks: selection.selected,
    none_reason: ctx ? noneReason(selection, candidates.length) : 'This run has no work item or task text to match a runbook against.',
    previous_attempts: input.previousAttempts ?? [],
    skill_library: await libraryOf(input.store, input.skillsDir === undefined ? BOX_SKILLS_DIR : input.skillsDir),
    budget_tokens: briefBudget(input.env ?? process.env),
    ...(input.fenceToken ? { fence_token: input.fenceToken } : {}),
  });
  return { brief, passedOver: passedOverRunbooks(selection, brief.omitted, candidates) };
}
