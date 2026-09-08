// Bolts a correct roving-tabindex keyboard tree (WAI-ARIA tree pattern) onto
// TreeView's (ui-components) rendered DOM. TreeView itself renders
// `role="tree"`/`role="treeitem"` rows with no `tabIndex`, no
// `aria-level`/`aria-expanded`, no arrow-key handling, and exposes no
// controlled `expanded`/`onToggle` prop to drive expand/collapse from outside
// (see docs/ui-components-queue.md) — this repo cannot edit the library
// (CLAUDE.md), so the roving-tabindex behavior lives here instead, reading
// the ACTUAL rendered DOM as the single source of truth for what rows are
// currently visible and expanded, rather than shadowing TreeView's own
// internal `expanded` Set in a second copy that could drift from it.
//
// Only KeyboardTreeView.tsx calls this — it's the pairing that keeps a
// `data-testid` in sync between the two.

import { useEffect, useRef } from 'react';
import { nextTreeFocus, treeDepth, treeParentId, type TreeArrowKey, type TreeParentShape } from './knowledgeFormat';

const ARROW_KEYS: ReadonlySet<string> = new Set<TreeArrowKey>(['ArrowUp', 'ArrowDown', 'Home', 'End']);

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value;
}

/** Strips the `data-testid` row prefix TreeView renders
 *  (`${treeTestId}-row-${nodeId}`) back down to the node id. */
function rowNodeId(el: Element, rowPrefix: string): string | null {
  const testId = el.getAttribute('data-testid');
  if (!testId || !testId.startsWith(rowPrefix)) return null;
  return testId.slice(rowPrefix.length);
}

/**
 * @param testId    The exact `data-testid` given to the paired `<TreeView>`.
 * @param nodes     The same node list handed to that `<TreeView>` — only
 *                  `id`/`parentId` are read, for `aria-level` and ArrowLeft's
 *                  "move to parent".
 * @param selectedId The tree's current selection — seeds the initial
 *                  roving-tabindex target (selected row, else the first row)
 *                  before any keyboard interaction has happened.
 */
export function useKeyboardTree(testId: string, nodes: TreeParentShape[], selectedId: string | null): void {
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;

  useEffect(() => {
    const root = document.querySelector(`[data-testid="${cssEscape(testId)}"]`);
    if (!root) return;
    const rowPrefix = `${testId}-row-`;

    const rows = (): HTMLElement[] => Array.from(root.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const idOf = (el: Element): string | null => rowNodeId(el, rowPrefix);
    const toggleButton = (row: Element): HTMLButtonElement | null =>
      row.querySelector<HTMLButtonElement>(':scope > button[aria-label="Expand"], :scope > button[aria-label="Collapse"]');

    /** Re-derives tabIndex/aria-level/aria-expanded for every visible row
     *  from what TreeView actually rendered. Idempotent — safe to call as
     *  often as we like, including from our own mutation observer. */
    const sync = () => {
      const els = rows();
      if (els.length === 0) return;
      const ids = els.map(idOf);
      const current = els.find((el) => el.tabIndex === 0);
      const currentId = current ? idOf(current) : null;
      const activeId = (currentId && ids.includes(currentId) ? currentId : null)
        ?? (selectedId && ids.includes(selectedId) ? selectedId : null)
        ?? ids[0];
      els.forEach((el, i) => {
        const id = ids[i];
        el.tabIndex = id !== null && id === activeId ? 0 : -1;
        if (id) el.setAttribute('aria-level', String(treeDepth(nodesRef.current, id) + 1));
        const toggle = toggleButton(el);
        if (toggle) el.setAttribute('aria-expanded', String(toggle.getAttribute('aria-label') === 'Collapse'));
        else el.removeAttribute('aria-expanded');
      });
    };

    /** Moves the roving tabindex (and real focus) to `id`, if it's currently
     *  visible. No-op otherwise — e.g. Home/End on an already-empty tree. */
    const focusTo = (id: string | null) => {
      if (!id) return;
      const els = rows();
      const target = els.find((el) => idOf(el) === id);
      if (!target) return;
      els.forEach((el) => { el.tabIndex = el === target ? 0 : -1; });
      target.focus();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const row = (e.target as HTMLElement).closest('[role="treeitem"]');
      if (!row) return;
      const currentId = idOf(row);
      if (!currentId) return;

      if (ARROW_KEYS.has(e.key)) {
        e.preventDefault();
        const visibleIds = rows().map(idOf).filter((id): id is string => id !== null);
        focusTo(nextTreeFocus(visibleIds, currentId, e.key as TreeArrowKey));
        return;
      }

      if (e.key === 'ArrowRight') {
        e.preventDefault();
        const expandToggle = row.querySelector<HTMLButtonElement>(':scope > button[aria-label="Expand"]');
        if (expandToggle) { expandToggle.click(); return; }
        // Already expanded (or a leaf, where this is a no-op): the first
        // child, when there is one, is the very next visible row.
        const visibleIds = rows().map(idOf).filter((id): id is string => id !== null);
        const idx = visibleIds.indexOf(currentId);
        if (idx >= 0 && idx + 1 < visibleIds.length) focusTo(visibleIds[idx + 1]!);
        return;
      }

      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const collapseToggle = row.querySelector<HTMLButtonElement>(':scope > button[aria-label="Collapse"]');
        if (collapseToggle) { collapseToggle.click(); return; }
        focusTo(treeParentId(nodesRef.current, currentId));
        return;
      }

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        (row as HTMLElement).click();
        toggleButton(row)?.click();
        return;
      }
    };

    root.addEventListener('keydown', onKeyDown as EventListener);
    const observer = new MutationObserver(sync);
    observer.observe(root, { childList: true, subtree: true });
    sync();

    return () => {
      root.removeEventListener('keydown', onKeyDown as EventListener);
      observer.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testId, selectedId]);
}
