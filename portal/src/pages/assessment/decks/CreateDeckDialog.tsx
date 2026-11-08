// "Create review deck": title and an optional subset of the team's rubric
// dimensions. Submitting launches the build (202 { deckId, runId }) and
// navigates to the deck page, which follows the run.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button, Checkbox, FormField, Inline, Input, Modal, Stack, Text } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../../hooks/useFetch';
import { toastError } from '../../../lib/toastStore';
import type { TeamDetailResponse } from '../types';
import { createDeck } from './decksApi';

interface CreateDeckDialogProps {
  open: boolean;
  onClose: () => void;
  teamId: string;
  teamName: string;
}

export function CreateDeckDialog({ open, onClose, teamId, teamName }: CreateDeckDialogProps) {
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { data: team } = useFetch<TeamDetailResponse>(open ? `/api/assessment/teams/${encodeURIComponent(teamId)}` : null);
  const dimensions = team?.dimensions ?? [];

  function toggle(id: string, on: boolean) {
    setPicked((prev) => { const next = new Set(prev); if (on) next.add(id); else next.delete(id); return next; });
  }

  async function submit() {
    setBusy(true);
    try {
      const { deckId } = await createDeck(teamId, {
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(picked.size > 0 ? { dimensionIds: [...picked] } : {}),
      });
      onClose();
      navigate(`/assessment/decks/${encodeURIComponent(deckId)}`);
    } catch (err) {
      toastError(null, 'Could not start the review deck', (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create review deck"
      maxWidth={480}
      footer={(
        <Inline gap="sm" justify="end">
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy} data-testid="create-deck-submit">
            {busy ? 'Starting…' : 'Create deck'}
          </Button>
        </Inline>
      )}
    >
      <Stack gap="md">
        <FormField label="Title">
          {({ id }) => <Input id={id} value={title} placeholder={`${teamName} assessment review`} onChange={(e) => setTitle(e.target.value)} />}
        </FormField>
        <Stack gap="xs">
          <Text className="text-sm font-medium">Dimensions</Text>
          <Text className="text-xs text-[var(--color-text-muted)]">
            {picked.size === 0 ? 'None selected: every assessed dimension gets a slide.' : `${picked.size} selected.`}
          </Text>
          {dimensions.map((d) => (
            <FormField key={d.id} label={`${d.id}. ${d.title}`} layout="inline">
              {({ labelId, id }) => (
                <Checkbox id={id} checked={picked.has(d.id)} onChange={(on) => toggle(d.id, on)} aria-labelledby={labelId} />
              )}
            </FormField>
          ))}
        </Stack>
      </Stack>
    </Modal>
  );
}
