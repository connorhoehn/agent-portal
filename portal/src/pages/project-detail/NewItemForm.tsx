// The inline "add work" form — used for a new epic at the top level and for a
// new story/bug inside an epic.

import { useState } from 'react';
import { Button, Card, FormRow, Inline, Input, NumberInput, Select, Stack } from '@connorhoehn/ui-components/shared';
import type { WorkItemPriority, WorkItemType } from './types';

const ALL_TYPES: WorkItemType[] = ['epic', 'story', 'bug'];
const PRIORITIES: WorkItemPriority[] = ['critical', 'high', 'medium', 'low'];

export interface NewItemDraft {
  title: string;
  type: WorkItemType;
  priority: WorkItemPriority;
  storyPoints: number | null;
}

export function NewItemForm({
  defaultType,
  typeOptions,
  onSave,
  onCancel,
}: {
  defaultType: WorkItemType;
  /** Which types the select offers — inside an epic that's story/bug only. */
  typeOptions?: WorkItemType[];
  onSave: (draft: NewItemDraft) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [type, setType] = useState<WorkItemType>(defaultType);
  const [priority, setPriority] = useState<WorkItemPriority>('medium');
  // Optional points at creation — without this, UI-created stories/bugs could
  // never be estimated (the ⚡ Estimate control requires storyPoints != null).
  const [points, setPoints] = useState<number | undefined>(undefined);

  // Epics are containers — they aren't sized, so the field hides for them, and
  // an out-of-range figure is treated as "unsized" rather than saved as-is.
  const parsedPoints = (): number | null => {
    if (type === 'epic' || points === undefined) return null;
    return Number.isFinite(points) && points >= 1 && points <= 21 ? points : null;
  };

  const canSave = title.trim().length > 0;
  const save = () => {
    if (!canSave) return;
    onSave({ title: title.trim(), type, priority, storyPoints: parsedPoints() });
  };

  // Enter commits from anywhere in the form and Escape backs out of it. The
  // handler sits on the container, not on each field: hanging it on both the
  // title box and the points box (as the hand-rolled version did) means an
  // Enter that bubbles fires `save` twice and creates the item twice.
  const onKeyDown = (e: React.KeyboardEvent) => {
    // preventDefault: closing the dialog hands focus back to the button that opened it, and the same Enter would
    // otherwise reach that button as a keypress and open its menu again.
    if (e.key === 'Enter') { if ((e.target as HTMLElement).tagName === 'INPUT') e.preventDefault(); save(); }
    if (e.key === 'Escape') onCancel();
  };

  return (
    <Card padding="sm" className="bg-surface-panel" onKeyDown={onKeyDown}>
      <Stack gap="sm">
        <Input
          autoFocus
          placeholder="Title…"
          aria-label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        {/* FormRow stacks the controls below 640px instead of squashing three
            of them plus a button pair onto one line. */}
        <FormRow gap="sm">
          <Select
            size="sm"
            aria-label="Type"
            value={type}
            onChange={(e) => setType(e.target.value as WorkItemType)}
            options={(typeOptions ?? ALL_TYPES).map((t) => ({ value: t, label: t }))}
          />
          <Select
            size="sm"
            aria-label="Priority"
            value={priority}
            onChange={(e) => setPriority(e.target.value as WorkItemPriority)}
            options={PRIORITIES.map((p) => ({ value: p, label: p }))}
          />
          {type !== 'epic' && (
            <Inline as="label" gap="xs" align="center" className="text-xs text-text-secondary">
              pts
              <NumberInput
                size="sm"
                min={1}
                max={21}
                placeholder="—"
                aria-label="Story points"
                value={points}
                onChange={setPoints}
                onClear={() => setPoints(undefined)}
              />
            </Inline>
          )}
        </FormRow>
        <Inline gap="xs" justify="end">
          <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={!canSave} onClick={save}>Create</Button>
        </Inline>
      </Stack>
    </Card>
  );
}
