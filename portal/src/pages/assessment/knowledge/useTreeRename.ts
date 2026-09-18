// Double-click a knowledge-tree row to rename it.
//
// `TreeViewProps` has `onSelect`, `onToggle` and `onReorder` but nothing for a
// double-click, and the row markup is the library's — so, like
// useKeyboardTree.ts beside this, the behaviour is bolted onto the rendered
// DOM rather than shadowed in a second copy of the tree's state. Same source of
// truth, same `data-testid` pairing: TreeView renders each row as
// `${treeTestId}-row-${nodeId}`, which is what maps a click target back to a
// node.
//
// Double-click is the affordance a file tree is expected to have, and unlike a
// 12px pencil it needs no aiming. The pencil stays for discoverability and for
// pointer users who never try the double-click, revealed on hover (app.css).

import { useEffect } from 'react';

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(value) : value;
}

export function useTreeRename(
  testId: string,
  onRename: ((nodeId: string) => void) | null,
): void {
  useEffect(() => {
    if (!onRename) return;
    const root = document.querySelector(`[data-testid="${cssEscape(testId)}"]`);
    if (!root) return;
    const rowPrefix = `${testId}-row-`;

    const handler = (ev: Event) => {
      const target = ev.target as Element | null;
      if (!target) return;
      // A double-click on the caret is an expand/collapse the user just did
      // twice, not a rename — and one on the pencil already has its own
      // handler, which would otherwise open the dialog and immediately reopen
      // it.
      if (target.closest('button')) return;
      const row = target.closest<HTMLElement>('[role="treeitem"]');
      const id = row?.getAttribute('data-testid');
      if (!id || !id.startsWith(rowPrefix)) return;
      const nodeId = id.slice(rowPrefix.length);
      if (!nodeId) return;
      // Stop the browser from selecting the label text under the pointer,
      // which otherwise leaves the row highlighted behind the dialog.
      window.getSelection?.()?.removeAllRanges();
      onRename(nodeId);
    };

    root.addEventListener('dblclick', handler);
    return () => root.removeEventListener('dblclick', handler);
  }, [testId, onRename]);
}
