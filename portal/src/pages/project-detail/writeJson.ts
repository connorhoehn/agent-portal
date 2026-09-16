// Optimistic-write plumbing for the board.
//
// Board edits apply locally first and are confirmed against the server. Every
// one of them used to be `.catch(() => {})`, which only fires on a network
// error: a 403, 404, 400 or 503 RESOLVES, so the response was thrown away and
// the local state kept showing a change the server had refused. These helpers
// make the confirm explicit — the caller reverts or reconciles on failure.

import { toastError, toastInfo } from '../../lib/toastStore';
import { HttpError } from '../../lib/writeJson';
import type { WorkItemTree } from './types';

/** Rewrite every node in a tree, children first. */
export function mapTree(nodes: WorkItemTree[], fn: (n: WorkItemTree) => WorkItemTree): WorkItemTree[] {
  return nodes.map((n) => fn({ ...n, children: mapTree(n.children, fn) }));
}

/** Drop one node (by id) wherever it sits in the tree. */
export function dropFromTree(nodes: WorkItemTree[], id: string): WorkItemTree[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, children: dropFromTree(n.children, id) }));
}

/** Insert a node as the last child of `parentId`, wherever that parent sits. */
export function insertChild(nodes: WorkItemTree[], parentId: string, child: WorkItemTree): WorkItemTree[] {
  return nodes.map((n) => (n.id === parentId
    ? { ...n, children: [...n.children, child] }
    : { ...n, children: insertChild(n.children, parentId, child) }));
}

/** Say what actually went wrong. 403 is a missing authority, not a bug; a
 *  client-minted id that never reached the server is a 404 worth naming. */
export function surfaceWriteError(err: unknown, what: string): void {
  if (err instanceof HttpError && err.status === 403) {
    toastInfo('Needs dispatch rights', `${what} requires dispatch rights on this initiative.`);
    return;
  }
  toastError(null, `${what} failed`, err instanceof Error ? err.message : String(err));
}

/** True for an id this page minted for an item the server has not acknowledged
 *  — writing against one can only 404. */
export function isPendingId(id: string): boolean {
  return id.startsWith('wi-new-');
}
