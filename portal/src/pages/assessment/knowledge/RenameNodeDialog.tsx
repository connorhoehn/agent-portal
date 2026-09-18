// The rename affordance for a knowledge-tree row.
//
// `TreeViewProps` carries `onReorder` but no `onRename` — unlike drag-and-drop,
// that one really is absent from the library, so a rename cannot be an inline
// edit on the row without reimplementing the row. What the library DOES give
// is `renderTrailing`, a per-row slot, and `DropdownMenu`, whose own docs
// describe this exact shape ("one trigger per row, forty rows") including the
// `triggerTabIndex={-1}` the roving-focus list needs. So the affordance is a
// trailing menu into a `Modal`, entirely from library parts.
//
// Queued as a library gap in docs/ui-components-queue.md: an `onRename` (or an
// editable `title` slot) would let the row rename in place, which is what a
// file tree usually does and what this has to approximate.

import { useEffect, useRef, useState } from 'react';
import {
  Button, EditIcon, IconButton, Input, Modal, Stack, T,
} from '@connorhoehnslalom/ui-components/shared';

export interface RenameNodeDialogProps {
  /** The row being renamed, or null when the dialog is closed. */
  node: { id: string; title: string } | null;
  onClose: () => void;
  /** Resolves when the server has accepted; rejects with the refusal text. */
  onSubmit: (id: string, title: string) => Promise<void>;
}

export function RenameNodeDialog({ node, onClose, onSubmit }: RenameNodeDialogProps) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset per opening rather than per render: reopening on a different row
  // must not inherit the previous row's half-typed name or its error.
  useEffect(() => {
    if (!node) return;
    setValue(node.title);
    setError(null);
    setBusy(false);
    // Select-all so typing replaces, which is what a rename usually wants.
    const id = window.setTimeout(() => inputRef.current?.select(), 0);
    return () => window.clearTimeout(id);
  }, [node]);

  const trimmed = value.trim();
  const unchanged = node !== null && trimmed === node.title;
  const submittable = trimmed.length > 0 && !unchanged && !busy;

  async function submit() {
    if (!node || !submittable) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(node.id, trimmed);
      onClose();
    } catch (err) {
      // The server's refusals name something actionable — which sibling
      // already has the name, which remote owns the section — so they are
      // shown verbatim rather than flattened to "rename failed".
      setError(err instanceof Error ? err.message : 'the rename could not be saved');
      setBusy(false);
    }
  }

  return (
    <Modal
      open={node !== null}
      onClose={onClose}
      title="Rename"
      maxWidth={420}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" size="sm" onClick={submit} disabled={!submittable}>
            {busy ? 'Renaming…' : 'Rename'}
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          }}
          invalid={error !== null}
          aria-label="New title"
          data-testid="rename-input"
        />
        {/* The id is a path other rows, versions, the comment channel and any
            shared URL all reference, so a rename changes the display title
            only. Saying so here stops it reading as a broken half-rename. */}
        <T className="text-[11px] text-text-tertiary">
          The document’s address does not change, so existing links keep working.
        </T>
        {error && (
          <T role="alert" className="text-[12px] text-danger">{error}</T>
        )}
      </Stack>
    </Modal>
  );
}

/**
 * The per-row trigger, for `TreeView`'s `renderTrailing` slot.
 *
 * A direct button rather than a menu: there is exactly one action here, and a
 * `DropdownMenu` whose only item is "Rename…" makes the reader open a menu to
 * discover that. If a second row action ever lands (duplicate, delete) this
 * becomes the menu the library already documents for per-row triggers.
 *
 * `tabIndex={-1}` for the same reason that menu would have needed it: one
 * trigger per row would otherwise put a tab stop in front of every document.
 * The control stays reachable — the rail's roving cursor moves through rows,
 * and the button is a real button for a pointer and for assistive tech.
 */
/** The per-row trigger, for `TreeView`'s `renderTrailing` slot. */
export function RowActionsMenu({ title, onRename }: { title: string; onRename: () => void }) {
  return (
    <IconButton
      aria-label={`Rename ${title}`}
      title="Rename"
      icon={<EditIcon size={12} />}
      variant="ghost"
      size="sm"
      tabIndex={-1}
      // Hidden until the row is hovered or something inside it takes focus —
      // a pencil on all 10 rows at once read as decoration and made the rail
      // busier than the documents in it. `opacity` rather than `display` on
      // purpose: the button keeps its box, so rows do not reflow as the
      // pointer moves down the tree, and `focus-within` keeps it reachable by
      // keyboard even though it is invisible at rest.
      //
      // The paired affordance is double-click on the row itself (wired in
      // KnowledgeExplorer), which is what a file tree conventionally does and
      // what does not require finding a 12px target at all.
      // The reveal itself is CSS in app.css, keyed on this class plus the
      // row's :hover / :focus-within — TreeView gives its rows no `group`
      // class to hang a Tailwind group-hover off, and the row markup is the
      // library's, not ours.
      className="doc-tree-rename"
      onClick={(e) => { e.stopPropagation(); onRename(); }}
    />
  );
}
