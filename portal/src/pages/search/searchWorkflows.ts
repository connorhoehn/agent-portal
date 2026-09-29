// The Search composer's "Workflow ⌄" rows (goal decision 6): three real prompt
// templates over the current query, scope and selection. The same rows feed
// "/ commands", so the menu and the slash list never disagree. No React;
// unit-tested alone.

import type { SearchRecord } from './searchTypes.ts';

export type SearchWorkflowId = 'who-can-help' | 'explain-selection' | 'summarize-results';

export interface SearchWorkflowRow {
  id: SearchWorkflowId;
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
  /** What the row puts in the composer; '' when disabled. */
  prompt: string;
}

export interface SearchWorkflowState {
  query: string;
  /** The scope's initiative id ('' or null for the whole workspace). */
  scope?: string | null;
  /** The scope's display name, when known; the id stands in otherwise. */
  scopeName?: string | null;
  selectedKeys: string[];
  /** The loaded records behind `selectedKeys` (may lag or be partial). */
  selectedRecords: SearchRecord[];
  /** How many results the current search returned; unknown → the query decides. */
  resultCount?: number;
}

const disabled = (row: Omit<SearchWorkflowRow, 'prompt' | 'disabled' | 'disabledReason'>, reason: string): SearchWorkflowRow =>
  ({ ...row, disabled: true, disabledReason: reason, prompt: '' });

export function searchWorkflows(state: SearchWorkflowState): SearchWorkflowRow[] {
  const query = state.query.trim();
  const scopeLabel = state.scope ? (state.scopeName?.trim() || state.scope) : '';
  const subject = query || scopeLabel;
  const count = state.selectedKeys.length;
  const hasResults = state.resultCount === undefined ? Boolean(query) : state.resultCount > 0 && Boolean(query || scopeLabel);
  const titles = state.selectedRecords.filter(r => state.selectedKeys.includes(`${r.type}:${r.id}`)).map(r => r.title);

  const whoCanHelp = { id: 'who-can-help' as const, label: 'Who can help', description: 'Owner, SMEs and blocked work for this search.' };
  const explain = { id: 'explain-selection' as const, label: 'Explain the selection', description: 'How the selected records connect and what needs attention.' };
  const summarize = { id: 'summarize-results' as const, label: 'Summarize results', description: 'Five cited bullets over the top results.' };

  return [
    subject
      ? { ...whoCanHelp, prompt: `Who can help with ${subject}? Name the owner, the SMEs and the blocked work.` }
      : disabled(whoCanHelp, 'Search for something first'),
    count
      ? { ...explain, prompt: count === 1
        ? `What is connected to ${titles[0] ?? 'this record'}, and what needs attention?`
        : `What connects these ${count} records${titles.length === count ? ` (${titles.join(', ')})` : ''}, and what needs attention?` }
      : disabled(explain, 'Select records first'),
    hasResults
      ? { ...summarize, prompt: `Summarize the top results for ${subject} in five bullets with a citation each.` }
      : disabled(summarize, 'Search for something first'),
  ];
}

/** Mirrors the library's ComposerCommand (as composerPrompts.ts does). */
export interface SearchWorkflowCommand {
  trigger: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

/** "/ commands" — the same rows as the Workflow menu. */
export function searchWorkflowCommands(rows: SearchWorkflowRow[]): SearchWorkflowCommand[] {
  return rows.map(row => ({ trigger: `/${row.id}`, label: row.label, hint: row.disabledReason ?? row.description, disabled: Boolean(row.disabled) }));
}

/** The workflow a draft starts with ("/who-can-help …"), if any. */
export function searchWorkflowIn(text: string, rows: SearchWorkflowRow[]): SearchWorkflowRow | null {
  const id = /^\/([\w-]+)/.exec(text.trim())?.[1]?.toLowerCase();
  return rows.find(row => row.id === id) ?? null;
}
