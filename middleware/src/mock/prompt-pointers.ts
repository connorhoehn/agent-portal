// DE-4 prompt pointers and lifecycle rows — SSM and Aurora, offline.
//
// Two fixtures, because they are two stores in the real world:
//   * `prompt-pointers`  — `/orgiq/prompts/<agent>/live|candidate`, one row per
//     agent holding both parameters (null = parameter absent).
//   * `prompt-lifecycle` — `observability.prompt_version_meta`, one row per
//     (promptId, version): the lifecycle status and the recorded eval rate.
//
// Both are fixtures rather than module arrays so a candidate / promote in
// dev:mock is undone by `POST /api/__mock/reset`, and so `empty` is reachable.
// Timestamps come from the mock clock, sampled inside the rows factory.
//
// `default` seeds every agent with NO pointer: the day-one state before the
// bootstrap script has run, in which each agent serves its baked prompt. The
// offline flow is therefore publish -> candidate -> promote, all of which work.

import { clock, defineFixture } from './core/index.js';

export const PROMPT_AGENTS = [
  'supervisor', 'search', 'scoring', 'advisor', 'ingestion', 'graph-builder', 'assessment-scorer', 'assessment-drafter',
] as const;

export interface PointerRef { promptId: string; version: string; weight?: number }

export interface PromptPointerRow {
  agent: string;
  live: PointerRef | null;
  candidate: PointerRef | null;
  updatedAt: string;
}

export interface PromptLifecycleRow {
  promptId: string;
  version: string;
  lifecycleStatus: 'draft' | 'published' | 'deployed' | 'promoted' | 'rolled_back' | 'superseded';
  /** 0..1 or null when no eval has been recorded for the version. */
  evalPassRate: number | null;
  updatedAt: string;
}

export const promptPointers = defineFixture<PromptPointerRow>({
  key: 'prompt-pointers',
  scenarios: {
    default: () => PROMPT_AGENTS.map((agent) => ({ agent, live: null, candidate: null, updatedAt: clock.nowIso() })),
    empty: () => [],
  },
});

export const promptLifecycle = defineFixture<PromptLifecycleRow>({
  key: 'prompt-lifecycle',
  scenarios: {
    default: () => [],
    empty: () => [],
  },
});

export function mockReadPointers(agent: string): { live: PointerRef | null; candidate: PointerRef | null } {
  const row = promptPointers.rows().find((r) => r.agent === agent);
  return { live: row?.live ? { ...row.live } : null, candidate: row?.candidate ? { ...row.candidate } : null };
}

export function mockWritePointers(agent: string, patch: { live?: PointerRef | null; candidate?: PointerRef | null }): void {
  const rows = promptPointers.rows();
  let row = rows.find((r) => r.agent === agent);
  if (!row) { row = { agent, live: null, candidate: null, updatedAt: clock.nowIso() }; rows.push(row); }
  if (patch.live !== undefined) row.live = patch.live;
  if (patch.candidate !== undefined) row.candidate = patch.candidate;
  row.updatedAt = clock.nowIso();
}

export function mockSetLifecycle(promptId: string, version: string, lifecycleStatus: PromptLifecycleRow['lifecycleStatus']): void {
  const rows = promptLifecycle.rows();
  const hit = rows.find((r) => r.promptId === promptId && r.version === version);
  if (hit) { hit.lifecycleStatus = lifecycleStatus; hit.updatedAt = clock.nowIso(); return; }
  rows.push({ promptId, version, lifecycleStatus, evalPassRate: null, updatedAt: clock.nowIso() });
}

export function mockGetLifecycle(promptId: string, version: string): PromptLifecycleRow | undefined {
  const r = promptLifecycle.rows().find((x) => x.promptId === promptId && x.version === version);
  return r ? { ...r } : undefined;
}

export function mockListLifecycle(promptId: string): PromptLifecycleRow[] {
  return promptLifecycle.rows().filter((r) => r.promptId === promptId).map((r) => ({ ...r }));
}
