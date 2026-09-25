// The Initiatives composer's words (F11, O10, W16, M5 and D5/D6): the context
// chip, the prefill or placeholder, the three prompt workflows behind
// "Workflow ▾" (the same list feeds "/ commands"), and the /iq/invoke link an
// Agent ask navigates to. No React; unit-tested alone.
//
// Prompts are built from row data — titles, owners, points, the blocked
// reason and next step — never from copy that pretends to know more than the
// rows say. The Agent mode only ASKS (the read-only org agent on the Ask
// page); dispatching a run stays in Run setup behind its capability gate.

import type { ProjectSummary } from '../projects/types';
import type { BriefFacts } from './briefModel.ts';
import type { FlatWorkItem } from './projectFormat.ts';
import type { ProjectDetail } from './types';

// ─── Subjects ────────────────────────────────────────────────────────────────

export type ComposerSubject =
  | { kind: 'initiatives'; rows: ProjectSummary[] | null }
  | { kind: 'initiative'; project: Pick<ProjectDetail, 'id' | 'name'>; rows: FlatWorkItem[] | null }
  | { kind: 'item'; project: Pick<ProjectDetail, 'id' | 'name'>; item: FlatWorkItem; facts: BriefFacts };

/** Mirrors the library's ComposerReference (plus L10's `marker`) without
 *  importing it, so this file stays runnable under plain node:test. */
export interface ComposerChip {
  id: string;
  label: string;
  title?: string;
  marker: 'dot';
}

export function composerChip(s: ComposerSubject): ComposerChip {
  switch (s.kind) {
    case 'initiatives': return { id: 'initiatives', label: 'Initiatives', marker: 'dot' };
    case 'initiative': return { id: s.project.id, label: s.project.name, marker: 'dot' };
    case 'item': return { id: s.item.id, label: 'This work item', title: s.item.title, marker: 'dot' };
  }
}

// ─── Prefill and placeholder ─────────────────────────────────────────────────

export const INITIATIVE_PREFILL = 'Help me prioritize the next changes and explain the tradeoffs.';
export const LIST_PLACEHOLDER = "Ask about the team's initiatives or how to get involved…";
export const INITIATIVE_PLACEHOLDER = 'Ask about this initiative…';
export const ITEM_PLACEHOLDER = 'Ask about this work item…';

/**
 * The item prefill, built from what the brief is missing:
 * no criteria + blocked → "Help me define acceptance criteria and identify
 * what Eli needs before this work can start." Unknown criteria (read pending
 * or failed) make no claim about criteria.
 */
export function itemPrefill(facts: BriefFacts): string {
  const who = facts.assigneeFirstName ?? 'the team';
  const noCriteria = facts.criteriaCount === 0;
  if (noCriteria && facts.blocked) {
    return `Help me define acceptance criteria and identify what ${who} needs before this work can start.`;
  }
  if (noCriteria) return 'Help me define acceptance criteria for this work.';
  if (facts.blocked) return `Help me identify what ${who} needs before this work can start.`;
  return 'Help me plan the next step for this work and explain the tradeoffs.';
}

export interface ComposerSetup {
  chip: ComposerChip;
  /** Prefilled text; '' when the composer opens empty (Send stays disabled). */
  draft: string;
  /** Key the prefill by subject so switching items never carries text across. */
  draftKey: string;
  placeholder: string;
}

export function composerSetup(s: ComposerSubject): ComposerSetup {
  const chip = composerChip(s);
  switch (s.kind) {
    case 'initiatives':
      return { chip, draft: '', draftKey: 'initiatives', placeholder: LIST_PLACEHOLDER };
    case 'initiative':
      return { chip, draft: INITIATIVE_PREFILL, draftKey: `initiative:${s.project.id}`, placeholder: INITIATIVE_PLACEHOLDER };
    case 'item':
      return { chip, draft: itemPrefill(s.facts), draftKey: `item:${s.item.id}`, placeholder: ITEM_PLACEHOLDER };
  }
}

// ─── Prompt workflows (D5) ───────────────────────────────────────────────────

export type WorkflowId = 'prioritize' | 'criteria' | 'unblock';

export interface ComposerWorkflow {
  id: WorkflowId;
  label: string;
  /** What it asks for — the menu's second line and the command hint. */
  description: string;
}

export const WORKFLOWS: readonly ComposerWorkflow[] = [
  { id: 'prioritize', label: 'Prioritize next work', description: 'Rank the open work and explain the tradeoffs' },
  { id: 'criteria', label: 'Define acceptance criteria', description: 'Draft testable criteria for this work item' },
  { id: 'unblock', label: 'Unblock this item', description: 'Work out what the owner needs to start' },
];

/** Why a workflow cannot run on this subject; null when it can. */
export function workflowUnavailable(id: WorkflowId, s: ComposerSubject): string | null {
  switch (id) {
    case 'prioritize':
      if (s.kind === 'item') return 'Open the initiative to prioritize its work';
      if (s.rows == null) return 'Still loading';
      return s.rows.length === 0 ? 'Nothing to prioritize yet' : null;
    case 'criteria':
      return s.kind === 'item' ? null : 'Open a work item first';
    case 'unblock':
      if (s.kind !== 'item') return 'Open a work item first';
      return s.facts.blocked ? null : 'This item is not blocked';
  }
}

/** The Workflow ▾ menu: every workflow, disabled with a reason where it does not apply. */
export function workflowMenu(s: ComposerSubject): Array<ComposerWorkflow & { disabledReason: string | null }> {
  return WORKFLOWS.map((w) => ({ ...w, disabledReason: workflowUnavailable(w.id, s) }));
}

/** Mirrors the library's ComposerCommand. */
export interface ComposerCommandSpec {
  trigger: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** "/ commands" — the same three workflows, so the menu and the slash list agree. */
export function composerCommands(s: ComposerSubject): ComposerCommandSpec[] {
  return workflowMenu(s).map((w) => ({
    trigger: `/${w.id}`,
    label: w.label,
    hint: w.disabledReason ?? w.description,
    disabled: w.disabledReason != null,
  }));
}

/** The workflow a draft starts with ("/unblock …"), if any. */
export function commandIn(text: string): WorkflowId | null {
  const m = /^\/(\w+)\b/.exec(text.trim());
  const id = m?.[1]?.toLowerCase();
  return WORKFLOWS.some((w) => w.id === id) ? (id as WorkflowId) : null;
}

const MAX_LISTED = 8;

function itemLine(r: FlatWorkItem): string {
  const parts = [r.assigneeName ?? 'unassigned', r.priority];
  if (r.storyPoints != null) parts.push(`${r.storyPoints} ${r.storyPoints === 1 ? 'point' : 'points'}`);
  if (r.labels.includes('blocked')) parts.push('blocked');
  return `- ${r.title} (${parts.join(', ')})`;
}

function initiativeLine(p: ProjectSummary): string {
  const parts: string[] = [p.status ?? 'no status'];
  if (p.ownerName) parts.push(`owner ${p.ownerName}`);
  if (p.pointsDone != null && p.pointsTotal != null) parts.push(`${p.pointsDone}/${p.pointsTotal} points`);
  if (p.activeAgentRuns != null) parts.push(p.activeAgentRuns > 0 ? `${p.activeAgentRuns} running` : 'idle');
  return `- ${p.name} (${parts.join(', ')})`;
}

function listed<T>(rows: T[], line: (r: T) => string): string {
  const shown = rows.slice(0, MAX_LISTED).map(line);
  if (rows.length > MAX_LISTED) shown.push(`- …and ${rows.length - MAX_LISTED} more`);
  return shown.join('\n');
}

/** The prompt a workflow sends, built from the subject's rows; null when it does not apply. */
export function workflowPrompt(id: WorkflowId, s: ComposerSubject): string | null {
  if (workflowUnavailable(id, s) != null) return null;
  if (id === 'prioritize' && s.kind === 'initiatives') {
    return `Help me decide which initiatives need attention first and explain the tradeoffs.\n\nInitiatives:\n${listed(s.rows ?? [], initiativeLine)}`;
  }
  if (id === 'prioritize' && s.kind === 'initiative') {
    const todo = (s.rows ?? []).filter((r) => r.status === 'open' || r.status === 'in_progress');
    const body = todo.length > 0 ? listed(todo, itemLine) : '- (nothing open)';
    return `${INITIATIVE_PREFILL}\n\nOpen work on ${s.project.name}:\n${body}`;
  }
  if (s.kind !== 'item') return null;
  const it = s.item;
  const lines: string[] = [];
  if (id === 'criteria') {
    lines.push(`Draft acceptance criteria for "${it.title}".`);
    const what = it.summary?.trim() || it.description?.trim();
    if (what) lines.push(`What it changes: ${what}`);
    lines.push('Write three to five criteria an engineer or agent could check, each one testable.');
  } else {
    const who = s.facts.assigneeFirstName ?? 'the owner';
    lines.push(`What does ${who} need before "${it.title}" can start?`);
    if (it.blockedReason?.trim()) lines.push(`Blocked because: ${it.blockedReason.trim()}`);
    if (it.nextStep?.trim()) lines.push(`Planned next step: ${it.nextStep.trim()}`);
    lines.push('Suggest the smallest step that unblocks it.');
  }
  return lines.join('\n');
}

// ─── The Ask link (D6) ───────────────────────────────────────────────────────

/** The typed question plus where it was asked from, so the org agent has the
 *  context the chip showed. Advise only: nothing here changes data. */
export function askPrompt(typed: string, s: ComposerSubject, withContext = true): string {
  const q = typed.replace(/^\/agent\s+/, '').trim();
  if (!withContext || !q) return q;
  switch (s.kind) {
    case 'initiatives':
      return `${q}\n\nAbout the organisation's initiatives. Advise only; do not change anything.`;
    case 'initiative':
      return `${q}\n\nAbout the initiative "${s.project.name}" (${s.project.id}). Advise only; do not change anything.`;
    case 'item':
      return `${q}\n\nAbout the work item "${s.item.title}" (${s.item.id}) on the initiative "${s.project.name}" (${s.project.id}). Advise only; do not change anything.`;
  }
}

/** `/iq/invoke?prompt=…` — the Ask page sends it once and strips the param. */
export function invokeHref(prompt: string): string {
  return `/iq/invoke?${new URLSearchParams({ prompt }).toString()}`;
}

/** Composer text → the Ask link, or null when there is nothing to ask. A
 *  leading "/workflow" expands to that workflow's prompt, then any text typed
 *  after the command is appended as the question. */
export function askHref(text: string, s: ComposerSubject, withContext = true): string | null {
  const cmd = commandIn(text);
  if (cmd) {
    const built = workflowPrompt(cmd, s);
    if (!built) return null;
    const rest = text.trim().replace(/^\/\w+\s*/, '').trim();
    return invokeHref(askPrompt(rest ? `${built}\n\n${rest}` : built, s, withContext));
  }
  const prompt = askPrompt(text, s, withContext);
  return prompt ? invokeHref(prompt) : null;
}
