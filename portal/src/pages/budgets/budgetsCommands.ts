// The Budgets reports' command composers. Initiatives: search the allocation
// ledger, refresh, or open one initiative by exact ID or name. Sprints: search
// the envelopes and refresh. Neither ever sets, changes or removes an
// allocation or grants an envelope — those stay explicit controls.
import { collectionCommandAdapter, resolveCollectionTarget, type CollectionGrammar } from '../../components/collections/collectionCommands.ts';
import type { CollectionCommandAdapter } from '../../components/collections/CollectionCommandHost.tsx';
import type { BudgetRow, GrantRow } from './types.ts';

export const INITIATIVE_BUDGETS_GRAMMAR: CollectionGrammar = { noun: 'initiatives' };
export const SPRINT_ENVELOPES_GRAMMAR: CollectionGrammar = { noun: 'sprints' };
export const INITIATIVE_BUDGETS_SCOPE_NOTE = 'Commands search the loaded allocation ledger by initiative, refresh it, or open one initiative by exact ID or name. They never set, change or remove an allocation.';
export const SPRINT_ENVELOPES_SCOPE_NOTE = 'Commands search the loaded sprint envelopes by initiative, sprint or SME and refresh them. They never grant, change or remove an envelope.';

const has = (values: Array<string | null>, query: string) => {
  const q = query.trim().toLowerCase();
  return !q || values.some(v => (v ?? '').toLowerCase().includes(q));
};
export const matchesBudget = (row: Pick<BudgetRow, 'orgProjectId' | 'orgProjectName'>, query: string) =>
  has([row.orgProjectName, row.orgProjectId], query);
export const matchesGrant = (row: Pick<GrantRow, 'orgProjectName' | 'sprintName' | 'granteeName'>, query: string) =>
  has([row.orgProjectName, row.sprintName, row.granteeName], query);

export function initiativeBudgetsCommandAdapter(controls: {
  setQuery(value: string): void;
  refresh(): void;
  rows: readonly Pick<BudgetRow, 'orgProjectId' | 'orgProjectName'>[];
  open(id: string): void;
}): CollectionCommandAdapter {
  return collectionCommandAdapter(INITIATIVE_BUDGETS_GRAMMAR, {
    setQuery: controls.setQuery, refresh: controls.refresh, scopeNote: INITIATIVE_BUDGETS_SCOPE_NOTE,
    label: 'Initiative budgets', id: 'budget-initiatives-commands',
    open(target) {
      const row = resolveCollectionTarget(target, controls.rows.map(r => ({ id: r.orgProjectId, title: r.orgProjectName ?? r.orgProjectId })));
      controls.open(row.id);
      return `Opening ${row.title}.`;
    },
  });
}

export function sprintEnvelopesCommandAdapter(controls: { setQuery(value: string): void; refresh(): void }): CollectionCommandAdapter {
  return collectionCommandAdapter(SPRINT_ENVELOPES_GRAMMAR, {
    setQuery: controls.setQuery, refresh: controls.refresh, scopeNote: SPRINT_ENVELOPES_SCOPE_NOTE,
    label: 'Sprint envelopes', id: 'budget-sprints-commands',
  });
}
