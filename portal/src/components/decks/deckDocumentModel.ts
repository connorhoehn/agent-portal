// Pure half of useDeckDocument, so `node --test` can load it.
import type { DocumentSaveState } from '@connorhoehnslalom/ui-components/doc-editor';

export const CONFLICT_MESSAGE = 'A newer version exists. Your edits are still here; reload the latest version to compare.';

/** Saved collaboration follows only the current head, never a historical revision or a dirty draft. */
export function deckRefreshAction(open: string | null, previousHead: string | null, nextHead: string | null, dirty: boolean): 'stay' | 'advance' | 'conflict' {
  if (!open || !previousHead || !nextHead || previousHead === nextHead) return 'stay';
  if (dirty) return 'conflict';
  return open === previousHead ? 'advance' : 'stay';
}

/** Locks that still name a slide in the spec being saved. */
export function keptLockedIds(locked: readonly string[] | undefined, slides: readonly { id: string }[]): string[] {
  return (locked ?? []).filter((id) => slides.some((s) => s.id === id));
}

/** The head revision a save is based on: the active one, else the newest. */
export function headRevisionId(deck: { activeRevisionId: string | null; revisions: readonly { id: string }[] } | null): string | null {
  return deck ? (deck.activeRevisionId ?? deck.revisions[0]?.id ?? null) : null;
}

/** The editor-shell save indicator, or undefined before a spec is open. */
export function deckSaveState(
  hasSpec: boolean, dirty: boolean, nextLabel: string, active: { label: string } | undefined,
): DocumentSaveState | undefined {
  if (!hasSpec) return undefined;
  if (dirty) return { status: 'pending', detail: `Unsaved changes. Save as ${nextLabel} to keep them` };
  return active ? { status: 'saved', detail: `Saved as ${active.label}` } : undefined;
}
