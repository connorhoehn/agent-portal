// The Initiatives composer's words (F11, O10, W16, M5 and D5/D6): the context
// chip, the prefill or placeholder, the three prompt workflows behind
// "Workflow ▾" (the same list feeds "/ commands"), and the /iq/invoke link an
// Agent ask navigates to. No React; unit-tested alone.
//
// Prompts are built from row data — titles, owners, points, the blocked
// reason and next step — never from copy that pretends to know more than the
// rows say. The Agent mode only ASKS (the read-only org agent on the Ask
// page); dispatching a run stays in Run setup behind its capability gate.

import { plural } from '../../lib/plural.ts';
import type { ProjectSummary } from '../projects/types';
import type { BriefFacts } from './briefModel.ts';
import type { FlatWorkItem } from './projectFormat.ts';
import type { ProjectDetail } from './types';
import { encodeAskScope, type AskScope } from '../../lib/askScope.ts';
import { derivedNextStep, type NextStepContext } from '../../lib/workNextStep.ts';

// ─── Subjects ────────────────────────────────────────────────────────────────

export type ComposerSubject =
  | { kind: 'initiatives'; rows: ProjectSummary[] | null }
  | { kind: 'initiative'; project: Pick<ProjectDetail, 'id' | 'name'>; rows: FlatWorkItem[] | null }
  | {
    kind: 'item'; project: Pick<ProjectDetail, 'id' | 'name'>; item: FlatWorkItem; facts: BriefFacts;
    /** The initiative's decisions and the item's criteria as the page read them: the next step is derived from them (lib/workNextStep.ts). */
    nextStepContext?: NextStepContext;
  };

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

/**
 * The draft's page reference as the composer header draws it — "Work ›
 * Initiatives › Auth Migration › Work › Logout leaves…". Titles come from the
 * rows this viewer just read; `page` is the only thing a Chat send carries
 * (`{kind,id}`), and each recipient's reader re-resolves titles from its own
 * authority. The initiatives list is not a page: it has no descriptor.
 */
export interface ComposerPageReference {
  id: string;
  crumbs: string[];
  label: string;
  page: { kind: 'initiative' | 'work-item'; id: string } | null;
}

export function composerPageReference(s: ComposerSubject): ComposerPageReference {
  const crumbs = s.kind === 'initiatives' ? ['Initiatives']
    : s.kind === 'initiative' ? [s.project.name]
    : [s.project.name, s.item.key ?? s.item.title];
  const page = s.kind === 'initiative' ? { kind: 'initiative' as const, id: s.project.id }
    : s.kind === 'item' ? { kind: 'work-item' as const, id: s.item.id } : null;
  return { id: page ? `${page.kind}:${page.id}` : 'initiatives', crumbs, label: crumbs.join(' › '), page };
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

/** One row of the Workflow ▾ menu, shaped for the library's DropdownMenuItem
 *  (2.390.4+): a workflow that does not apply here is `disabled`, and the menu
 *  prints `disabledReason` as its second line and tooltip — it never fires. */
export interface WorkflowMenuRow {
  id: WorkflowId;
  label: string;
  description?: string;
  disabled: boolean;
  disabledReason?: string;
}

export function workflowMenuRows(s: ComposerSubject): WorkflowMenuRow[] {
  return workflowMenu(s).map((w) => (w.disabledReason != null
    ? { id: w.id, label: w.label, disabled: true, disabledReason: w.disabledReason }
    : { id: w.id, label: w.label, description: w.description, disabled: false }));
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
  return `- ${r.key ? `${r.key}: ` : ''}${r.title} (${parts.join(', ')})`;
}

function initiativeLine(p: ProjectSummary): string {
  const parts: string[] = [p.status ?? 'no status'];
  if (p.ownerName) parts.push(`owner ${p.ownerName}`);
  if (p.pointsDone != null && p.pointsTotal != null) parts.push(`${p.pointsDone}/${plural(p.pointsTotal, 'point')}`);
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
    // The derived step (the Brief tab's), never the stored field: a decision the item waits on comes first.
    const next = derivedNextStep(it, s.nextStepContext);
    if (next) lines.push(`Planned next step: ${next.step}${next.from === 'decision' && next.detail ? ` ${next.detail}` : ''}`);
    lines.push('Suggest the smallest step that unblocks it.');
  }
  return lines.join('\n');
}

// ─── The Ask link (D6) ───────────────────────────────────────────────────────

/** The typed question, with any leading `/agent` dropped. Where it was asked
 *  from travels separately, as `composerScope` — never glued onto the text,
 *  which is what Search shows as the query, the title and the transcript. */
export function askPrompt(typed: string): string {
  return typed.replace(/^\/agent\s+/, '').trim();
}

/** What the composer's context chip was showing, as a structured scope; null
 *  when the asker removed the context. Advise only is the stance of every
 *  composer ask (lib/askScope.ts). */
export function composerScope(s: ComposerSubject, withContext = true): AskScope | null {
  if (!withContext) return null;
  switch (s.kind) {
    case 'initiatives': return { kind: 'initiatives' };
    case 'initiative': return { kind: 'initiative', id: s.project.id };
    case 'item': return { kind: 'work', id: s.item.id };
  }
}

/** `/iq/invoke?prompt=…[&about=…]` — the Ask page sends it once and strips `prompt`; `about` stays as the conversation's scope. */
export function invokeHref(prompt: string, scope: AskScope | null = null): string {
  return `/iq/invoke?${new URLSearchParams({ prompt, ...(scope ? { about: encodeAskScope(scope) } : {}) }).toString()}`;
}

/** Composer text → a question, or null when there is nothing to ask. A
 *  leading "/workflow" expands to that workflow's prompt, then any text typed
 *  after the command is appended as the question. */
export function composerAsk(text: string, s: ComposerSubject): string | null {
  const cmd = commandIn(text);
  if (cmd) {
    const built = workflowPrompt(cmd, s);
    if (!built) return null;
    const rest = text.trim().replace(/^\/\w+\s*/, '').trim();
    return askPrompt(rest ? `${built}\n\n${rest}` : built);
  }
  const prompt = askPrompt(text);
  return prompt || null;
}

/** Standalone Ask views can still use a deep link; initiative details run in their pane. */
export function askHref(text: string, s: ComposerSubject, withContext = true): string | null {
  const prompt = composerAsk(text, s);
  return prompt ? invokeHref(prompt, composerScope(s, withContext)) : null;
}
