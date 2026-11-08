// The initiative page's "Status deck" action: a button that opens a dialog with
// the initiative's existing decks and, for DispatchAgentRun holders, a build
// form (optional Nova narrative; budget figures only for the budgets read tier,
// which the server re-decides). Generation is synchronous; on success it opens
// the new deck. A deck with budget figures is listed only to readers of budgets.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Checkbox, FormField, InlineAlert, Inline, Input, Modal, Stack, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { useCapabilities } from '../../../lib/capabilities';
import { toastError, toastSuccess } from '../../../lib/toastStore';
import { createInitiativeDeck, initiativeDeckPaths, narrativeNotice, statusDeckDialogState, type InitiativeDeckSummary } from './initiativeDecksApi';

export function InitiativeStatusDecks({ projectId, projectName, open: openProp, onOpenChange, hideTrigger = false }: {
  projectId: string; projectName: string;
  // Optional control, so a host can open the dialog from a menu item.
  open?: boolean; onOpenChange?: (open: boolean) => void; hideTrigger?: boolean;
}) {
  const navigate = useNavigate();
  const { can } = useCapabilities();
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => { setOpenState(next); onOpenChange?.(next); };
  const [title, setTitle] = useState('');
  const [narrative, setNarrative] = useState(false);
  const [budget, setBudget] = useState(true);
  const [busy, setBusy] = useState(false);
  const decks = useFetch<InitiativeDeckSummary[]>(open ? initiativeDeckPaths.list(projectId) : null);
  const rows = decks.data ?? [];
  const canBuild = can('DispatchAgentRun');
  const canBudget = can('ManageBudgets');
  const view = statusDeckDialogState({ canBuild, deckCount: rows.length, projectName });

  async function submit() {
    setBusy(true);
    try {
      const out = await createInitiativeDeck(projectId, {
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(narrative ? { narrative: true } : {}),
        ...(canBudget && !budget ? { includeBudget: false } : {}),
      });
      const notice = narrativeNotice(out.narrative);
      if (notice) toastSuccess(null, 'Status deck built', notice);
      setOpen(false);
      navigate(initiativeDeckPaths.page(out.deckId));
    } catch (err) {
      toastError(null, 'Could not build the status deck', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!hideTrigger && <Button size="sm" variant="secondary" onClick={() => setOpen(true)} data-testid="initiative-deck-open">Status deck</Button>}
      <Modal
        open={open} onClose={() => setOpen(false)} title="Status deck" maxWidth={520}
        {...(view.showBuild ? {
          footer: (
            <Inline gap="sm" justify="end">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button variant="primary" onClick={() => void submit()} disabled={busy} data-testid="initiative-deck-submit">{busy ? 'Building…' : 'Build deck'}</Button>
            </Inline>
          ),
        } : {})}
      >
        <Stack gap="md" data-testid="initiative-deck-dialog">
          <Stack gap="xs" data-testid="initiative-deck-list">
            {view.notice && <InlineAlert tone="info" data-testid="initiative-deck-readonly-notice">{view.notice}</InlineAlert>}
            <T className="text-sm font-semibold text-text-primary">Existing decks ({rows.length})</T>
            {view.emptyText
              ? <T className="text-sm text-text-muted">{view.emptyText}</T>
              : rows.map((d) => (
                <Inline key={d.id} gap="sm" align="center">
                  <Button size="sm" variant="ghost" onClick={() => navigate(initiativeDeckPaths.page(d.id))} data-testid="initiative-deck-link">{view.primary === 'open' ? `Open ${d.title}` : d.title}</Button>
                  <T className="text-xs text-text-muted">{d.latestRevision?.label ?? 'no version'}{d.includesBudget ? ' · with budget' : ''}</T>
                </Inline>
              ))}
          </Stack>
          {view.showBuild && (
            <Stack gap="md">
              <FormField label="Title">
                {({ id }) => <Input id={id} value={title} placeholder={`${projectName} — status`} onChange={(e) => setTitle(e.target.value)} />}
              </FormField>
              <FormField label="Write a narrative with Nova" layout="inline">
                {({ labelId, id }) => <Checkbox id={id} checked={narrative} onChange={setNarrative} aria-labelledby={labelId} data-testid="initiative-deck-narrative" />}
              </FormField>
              {canBudget && (
                <FormField label="Include budget and maintenance figures" layout="inline">
                  {({ labelId, id }) => <Checkbox id={id} checked={budget} onChange={setBudget} aria-labelledby={labelId} data-testid="initiative-deck-budget" />}
                </FormField>
              )}
              <InlineAlert tone="info">
                Counts, points, estimates, sprints and decisions are read from the initiative record. Nova only writes prose, and only quotes the record.
                {canBudget ? ' A deck with budget figures is visible only to roles that can read budgets and cannot be shared to a channel.' : ' Your role gets a deck without budget figures.'}
              </InlineAlert>
            </Stack>
          )}
        </Stack>
      </Modal>
    </>
  );
}
