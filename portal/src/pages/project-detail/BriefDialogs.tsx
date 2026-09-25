// The two writes behind "Complete the brief" (W14): "Add a note" writes a
// planning note to the item's thread, "Add context" links one of the
// initiative's decisions to the item (PUT /api/graph/work-items/:id/decisions/
// :decisionId, M4). Both sit behind the board's write gate; the Brief only
// offers them to a role that holds it, and the server refuses anyone else.

import { useState } from 'react';
import { ActionRowList } from '@connorhoehnslalom/ui-components';
import { Button, FormField, Inline, Modal, Stack, T, Textarea } from '@connorhoehnslalom/ui-components/shared';
import { sendJson } from '../../lib/writeJson';
import { surfaceWriteError } from './writeJson';
import type { ProjectDecision } from './types';

export function AddNoteDialog({ itemTitle, onPost, onClose }: {
  itemTitle: string;
  /** Resolves true once the server has the note. */
  onPost: (text: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onPost(text.trim());
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a planning note"
      maxWidth={560}
      footer={(
        <Inline gap="sm" justify="end">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => { void submit(); }} disabled={!text.trim() || busy} data-testid="add-note-save">
            {busy ? 'Saving…' : 'Add note'}
          </Button>
        </Inline>
      )}
    >
      <FormField label="Note" hint={`Posted to the discussion on "${itemTitle}".`}>
        {(wiring) => (
          <Textarea
            {...wiring}
            autoFocus
            minRows={4}
            autoResize
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="What should the next person to pick this up know?"
            data-testid="add-note-text"
          />
        )}
      </FormField>
    </Modal>
  );
}

const STATUS_WORD: Record<string, string> = {
  escalated: 'Escalated', open: 'Open', resolved: 'Resolved', rejected: 'Rejected',
};

export function LinkDecisionDialog({ itemId, itemTitle, decisions, onLinked, onClose }: {
  itemId: string;
  itemTitle: string;
  /** Every decision on the initiative. */
  decisions: ProjectDecision[];
  onLinked: () => void;
  onClose: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  // A decision already linked here is not offered; one linked to another item
  // is shown but refused — the server never re-points a link silently.
  const candidates = decisions.filter((d) => d.workItemId !== itemId);

  const link = async (decisionId: string) => {
    if (busyId) return;
    setBusyId(decisionId);
    try {
      await sendJson(`/api/graph/work-items/${encodeURIComponent(itemId)}/decisions/${encodeURIComponent(decisionId)}`, 'PUT');
      onLinked();
      onClose();
    } catch (err) {
      surfaceWriteError(err, 'Linking this decision');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal open onClose={onClose} title="Add context" maxWidth={640}>
      <Stack gap="md">
        <T as="p" className="text-text-secondary">
          {`Link a decision "${itemTitle}" depends on.`}
        </T>
        <ActionRowList
          aria-label="Decisions on this initiative"
          items={candidates.map((d) => ({
            id: d.id,
            title: d.topic,
            ...(d.summary ? { description: d.summary } : {}),
            meta: STATUS_WORD[d.status] ?? d.status,
            ...(d.workItemId
              ? { disabled: true, disabledReason: 'Already linked to another work item' }
              : busyId ? { disabled: true, disabledReason: 'Linking…' } : {}),
          }))}
          onOpen={(row) => { void link(row.id); }}
          emptyLabel="This initiative has no other decisions to link."
          data-testid="link-decision-list"
        />
      </Stack>
    </Modal>
  );
}
