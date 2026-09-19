// The installed TreeView owns keyboard navigation and roving focus. This
// wrapper adds only double-click rename, which is not exposed by the library.

import { TreeView, type TreeViewProps } from '@connorhoehnslalom/ui-components/shared';
import { useTreeRename } from './useTreeRename';

export type KeyboardTreeViewProps = Omit<TreeViewProps, 'data-testid'> & {
  /** Required (TreeView's own default `'tree-view'` isn't unique per
   *  section) — useTreeRename needs it to scope its DOM queries to this
   *  tree alone when a page renders more than one. */
  'data-testid': string;
  /**
   * Double-click a row to rename it — the affordance a file tree is expected
   * to have, and the one that needs no aiming at a 12px control. Omitted (or
   * null) for a tree whose viewer may not rename, which is the same gate the
   * trailing pencil is behind.
   */
  onRenameNode?: ((nodeId: string) => void) | null;
};

export function KeyboardTreeView({ nodes, selectedId, onRenameNode, ...rest }: KeyboardTreeViewProps) {
  useTreeRename(rest['data-testid'], onRenameNode ?? null);
  return <TreeView nodes={nodes} selectedId={selectedId} {...rest} />;
}

export default KeyboardTreeView;
