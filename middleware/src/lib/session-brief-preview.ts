// Assemble a session brief for a work item WITHOUT freezing it — what a box
// would be told if the work were dispatched now (design §3.5, "Work item →
// Brief preview"). Pure orchestration over the lane A model: it gathers the
// published runbooks, selects and assembles; it never calls putBrief.
//
// The run_ref is `preview-<work item id>`, so a preview's id and bytes are
// deterministic for a given world but can never collide with a real run's.
import type { RunbookStore } from './runbooks/store.js';
import {
  assembleBrief, briefBudget, runbookHealth, selectRunbooks,
  type BriefDecision, type RunbookCandidate, type SessionBrief,
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

export async function previewBrief(input: {
  store: RunbookStore;
  work: PreviewWork;
  parent: { title: string } | null;
  project: PreviewProject | null;
  decisions: PreviewDecision[];
  pinned: string[];
  nowIso: string;
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<SessionBrief> {
  const { work, project } = input;
  const candidates = await loadCandidates(input.store, Date.parse(input.nowIso));
  const selection = selectRunbooks({
    id: work.id, title: work.title, description: work.description ?? '', labels: work.labels,
    repo: project?.repoFullName ?? null, initiative_id: project?.id ?? null, pinned_runbook_ids: input.pinned,
  }, candidates);
  return assembleBrief({
    run_ref: `preview-${work.id}`,
    assembled_at: input.nowIso,
    framing: '',
    work_item: {
      id: work.id, title: work.title, kind: work.type, points: work.storyPoints,
      description: work.description ?? '', labels: work.labels,
      parent_epic: input.parent ? { title: input.parent.title } : null,
    },
    initiative: project ? { id: project.id, name: project.name, repo: project.repoFullName } : null,
    repo: project?.repoFullName ?? null,
    decisions: input.decisions.map(decisionLine),
    runbooks: selection.selected,
    budget_tokens: briefBudget(input.env ?? process.env),
  });
}
