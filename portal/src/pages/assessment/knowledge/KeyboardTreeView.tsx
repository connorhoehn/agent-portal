// Drop-in replacement for ui-components' `TreeView` that adds the keyboard
// model TreeView itself doesn't have (see useKeyboardTree.ts and
// docs/ui-components-queue.md). Renders the exact same single `<TreeView>`
// element KnowledgeExplorer used directly before — this file adds no markup
// of its own, only the hook that manages that element's DOM.

import { TreeView, type TreeViewProps } from '@connorhoehnslalom/ui-components/shared';
import { useKeyboardTree } from './useKeyboardTree';

export type KeyboardTreeViewProps = Omit<TreeViewProps, 'data-testid'> & {
  /** Required (TreeView's own default `'tree-view'` isn't unique per
   *  section) — useKeyboardTree needs it to scope its DOM queries to this
   *  tree alone when a page renders more than one. */
  'data-testid': string;
};

export function KeyboardTreeView({ nodes, selectedId, ...rest }: KeyboardTreeViewProps) {
  useKeyboardTree(rest['data-testid'], nodes, selectedId);
  return <TreeView nodes={nodes} selectedId={selectedId} {...rest} />;
}

export default KeyboardTreeView;
