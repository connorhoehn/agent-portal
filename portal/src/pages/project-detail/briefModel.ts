// A work item's Brief tab model (mockup variant 2): the meta-row flags, the
// "Next step" callout, the three-row "Complete the brief" table and the Run
// setup hint. No React; unit-tested alone.
//
// Each table row is derived from a read the page already makes — acceptance
// criteria, the initiative's decisions linked to this item, and the item's
// non-system comments. A read that is still loading or failed is a state of
// that row, never "Not defined yet": saying "nothing here" about data we
// could not read is the honest-numbers class-3 lie.

import { firstName } from './overviewModel.ts';
import { isBlocked } from './workListModel.ts';
import type { FlatWorkItem } from './projectFormat.ts';
import type { ProjectDecision, WorkItemPriority } from './types';
import type { Criterion, ThreadComment } from './useWorkItemThread.ts';

/** One read as the page holds it: data once loaded, or an error. */
export interface Read<T> {
  data: T | null | undefined;
  error?: string | null;
}

// ─── Meta row ────────────────────────────────────────────────────────────────

export interface ItemFlag {
  label: string;
  tone: 'danger' | 'warning';
}

/** The tags beside the status in the meta row ("Blocked"). Only while the
 *  item is still to do — a done item's stale label is history, not a flag. */
export function itemFlags(item: Pick<FlatWorkItem, 'labels' | 'status'>): ItemFlag[] {
  const live = item.status !== 'done' && item.status !== 'cancelled';
  return live && isBlocked(item) ? [{ label: 'Blocked', tone: 'danger' }] : [];
}

const PRIORITY_WORD: Record<WorkItemPriority, string> = {
  critical: 'Critical priority', high: 'High priority', medium: 'Medium priority', low: 'Low priority',
};

/** "High priority" — the meta row's priority tag. */
export function priorityTag(priority: WorkItemPriority): { label: string; tone: 'danger' | 'warning' | 'neutral' } {
  const tone = priority === 'critical' || priority === 'high' ? 'danger' : priority === 'medium' ? 'warning' : 'neutral';
  return { label: PRIORITY_WORD[priority], tone };
}

// ─── Why this matters / Next step ────────────────────────────────────────────

export const WHY_TITLE = 'Why this matters';

export interface NextStepCallout {
  title: 'Next step';
  /** "Confirm the dependency map with Eli Garcia." */
  step: string;
  /** "The team needs this before choosing how to group duplicate alerts." */
  detail: string | null;
  actionLabel: 'Open discussion';
}

/** The amber callout; null when the row carries no next step (hidden, not faked). */
export function nextStepCallout(item: Pick<FlatWorkItem, 'nextStep' | 'nextStepDetail'>): NextStepCallout | null {
  const step = item.nextStep?.trim();
  if (!step) return null;
  return { title: 'Next step', step, detail: item.nextStepDetail?.trim() || null, actionLabel: 'Open discussion' };
}

// ─── Complete the brief ──────────────────────────────────────────────────────

export const BRIEF_TITLE = 'Complete the brief';
export const BRIEF_BODY = 'Add enough detail for an engineer or agent to know what success looks like.';
export const EDIT_DENIED = 'Your role cannot edit work items';

export type BriefRowId = 'criteria' | 'decisions' | 'notes';

export interface BriefRow {
  id: BriefRowId;
  label: string;
  /** "Not defined yet", "3 defined · 1 met", "Loading…", "Couldn't load criteria". */
  value: string;
  /** Muted when the value says "nothing here yet" or is a transient state. */
  muted: boolean;
  state: 'loading' | 'error' | 'empty' | 'filled';
  /** True once there is something written — the page then renders the full section. */
  filled: boolean;
  action: { label: string; disabledReason: string | null } | null;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

function row(
  id: BriefRowId,
  label: string,
  read: Read<unknown[]>,
  what: string,
  empty: string,
  filledValue: (n: number) => string,
  action: (filled: boolean) => BriefRow['action'],
): BriefRow {
  if (read.error) {
    return { id, label, value: `Couldn't load ${what}`, muted: true, state: 'error', filled: false, action: null };
  }
  if (read.data == null) {
    return { id, label, value: 'Loading…', muted: true, state: 'loading', filled: false, action: null };
  }
  const n = read.data.length;
  if (n === 0) return { id, label, value: empty, muted: true, state: 'empty', filled: false, action: action(false) };
  return { id, label, value: filledValue(n), muted: false, state: 'filled', filled: true, action: action(true) };
}

export interface BriefInputs {
  itemId: string;
  criteria: Read<Criterion[]>;
  /** The initiative's decisions; this item's are the ones whose workItemId matches. */
  decisions: Read<ProjectDecision[]>;
  /** The item's thread; notes are the rows people wrote (`!isSystem`). */
  comments: Read<ThreadComment[]>;
  /** The writeGate: may this session edit work items? */
  canEdit: boolean;
}

export interface BriefModel {
  rows: BriefRow[];
  /** False once all three are filled — the full sections say it all. */
  showTable: boolean;
}

export function buildBrief(input: BriefInputs): BriefModel {
  const denied = input.canEdit ? null : EDIT_DENIED;
  const linked: Read<ProjectDecision[]> = {
    data: input.decisions.data?.filter((d) => d.workItemId === input.itemId),
    error: input.decisions.error,
  };
  const notes: Read<ThreadComment[]> = {
    data: input.comments.data?.filter((c) => !c.isSystem),
    error: input.comments.error,
  };
  const criteriaMet = (input.criteria.data ?? []).filter((c) => c.done).length;

  const rows: BriefRow[] = [
    row('criteria', 'Acceptance criteria', input.criteria, 'criteria', 'Not defined yet',
      (n) => `${n} defined · ${criteriaMet} met`,
      // Drafting with the agent only asks; it writes nothing, so every role may.
      (filled) => (filled ? { label: 'Edit', disabledReason: denied } : { label: 'Draft with agent', disabledReason: null })),
    row('decisions', 'Dependencies and decisions', linked, 'decisions', 'No links added',
      (n) => `${n} linked`,
      () => ({ label: 'Add context', disabledReason: denied })),
    row('notes', 'Planning notes', notes, 'notes', 'No notes added',
      (n) => `${n} ${plural(n, 'note')}`,
      () => ({ label: 'Add a note', disabledReason: denied })),
  ];
  return { rows, showTable: !rows.every((r) => r.filled) };
}

// ─── Run setup ───────────────────────────────────────────────────────────────

export const RUN_SETUP_TITLE = 'Run setup';

export interface RunSetupInputs {
  /** DispatchAgentRun from /api/session/capabilities. */
  canDispatch: boolean;
  /** The session is an sme — the only role grant-scoped dispatch restricts. */
  isSme: boolean;
  /** hasActiveGrantOnInitiative over /api/sprints?scope=mine; null while unread. */
  hasGrant: boolean | null;
  model?: string | null;
  repo?: string | null;
  capUsd?: number | null;
}

/** The collapsed Run setup's one-line hint. */
export function runSetupHint(i: RunSetupInputs): string {
  if (!i.canDispatch) return 'SME or release manager required to dispatch';
  if (i.isSme && i.hasGrant === false) return 'Needs an active sprint grant on this initiative';
  const parts: string[] = [];
  if (i.model) parts.push(i.model);
  if (i.repo) parts.push(i.repo);
  if (i.capUsd != null) parts.push(`cap $${i.capUsd.toFixed(2)}`);
  return parts.length > 0 ? parts.join(' · ') : 'Ready to dispatch';
}

// ─── Prompt facts ────────────────────────────────────────────────────────────

/** What the composer's item prefill needs to know about the brief. `null`
 *  criteria means unknown (loading or failed) — the prefill then makes no
 *  claim about criteria either way. */
export interface BriefFacts {
  criteriaCount: number | null;
  blocked: boolean;
  assigneeFirstName: string | null;
}

export function briefFacts(item: Pick<FlatWorkItem, 'labels' | 'status' | 'assigneeName'>, criteria: Read<Criterion[]>): BriefFacts {
  return {
    criteriaCount: criteria.error || criteria.data == null ? null : criteria.data.length,
    blocked: itemFlags(item).length > 0,
    assigneeFirstName: firstName(item.assigneeName),
  };
}
