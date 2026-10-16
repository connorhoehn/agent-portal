// Assemble a session brief for a work item WITHOUT freezing it — what a box
// would be told if the work were dispatched now (design §3.5, "Work item →
// Brief preview"). Pure orchestration over the lane A model: it gathers the
// published runbooks, selects and assembles; it never calls putBrief.
//
// The run_ref is `preview-<work item id>`, so a preview's id and bytes are
// deterministic for a given world but can never collide with a real run's.
import type { RunbookStore } from './runbooks/store.js';
import {
  assembleBrief, briefBudget, runbookHealth, loadSkillLibrary, BOX_SKILLS_DIR,
  type BriefDecision, type BriefSkill, type BriefSkillLibrary, type RunbookCandidate, type SessionBrief,
} from './runbooks/index.js';

export interface PreviewWork {
  id: string;
  title: string;
  description: string | null;
  type: string;
  storyPoints: number | null;
  labels: string[];
  parentId: string | null;
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

/**
 * Assemble a brief for a work item (or, with no work item, for a free-form
 * task) without storing it. The preview route calls it with
 * `run_ref: preview-<id>`; lib/run-brief.ts calls it with the real run ref and
 * then freezes the result — ONE assembly path, so a preview and the brief a
 * run receives differ only in what the run ref and the clock make differ.
 */
/** The org's skill library as a brief records it: its sha, where this box installs it, every skill's version. */
async function libraryOf(store: RunbookStore, dir: string | null): Promise<BriefSkillLibrary> {
  const lib = await loadSkillLibrary(store);
  return { sha256: lib.sha256, dir, skills: lib.skills.map((k) => ({ name: k.name, version: k.version })) };
}

export async function previewBrief(input: {
  store: RunbookStore;
  work: PreviewWork | null;
  parent: { title: string } | null;
  project: PreviewProject | null;
  decisions: PreviewDecision[];
  pinned: string[];
  nowIso: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Defaults to `preview-<work item id>`. */
  run_ref?: string;
  /** Skills installed on the box (the live session bundle's), devbox runs only. */
  skills?: BriefSkill[];
  /** A job with no work item: its title and prompt are what selection reads. */
  task?: { title: string; text: string } | null;
  /** Overrides the project's repo (a governed run's checkout). */
  repo?: string | null;
  /**
   * R8: where this run's box installs the org's skill library — `~/.claude/skills` on a devbox
   * (the default), null on a machine that does not sync it (a local worker).
   */
  skillsDir?: string | null;
}): Promise<SessionBrief> {
  const { work, project } = input;
  const runRef = input.run_ref ?? `preview-${work?.id ?? 'task'}`;
  const repo = input.repo ?? project?.repoFullName ?? null;
  return assembleBrief({
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
    ...(input.skills?.length ? { skills: input.skills } : {}),
    skill_library: await libraryOf(input.store, input.skillsDir === undefined ? BOX_SKILLS_DIR : input.skillsDir),
    budget_tokens: briefBudget(input.env ?? process.env),
  });
}
