import { useId, useState } from 'react';
import { Button, Chip, DataTable, FormField, Inline, InlineAlert, Input, Modal, PersonPicker, Select, Stack, Switch, T } from '@connorhoehnslalom/ui-components/shared';
import { writeJson } from '../../lib/writeJson';
import { useSocialPlane } from './socialPlane';
import type { HangoutPlan, NameOf, SocialRoom } from './socialPlatform';

/** Product-specific composition of the library's form and people controls. */
export default function RoomConfiguration({ room, people, nameOf, onClose, onSaved, scope = 'settings' }: {
  scope?: 'settings' | 'layout';
  room: SocialRoom;
  people: readonly { userId: string; displayName: string }[];
  nameOf: NameOf;
  onClose(): void;
  onSaved(room: SocialRoom): void;
}) {
  const { api } = useSocialPlane();
  const formId = useId();
  const [settings, setSettings] = useState(room.settings);
  const [rooms, setRooms] = useState<HangoutPlan['rooms']>(() => structuredClone(room.plan?.rooms ?? []));
  const [mode, setMode] = useState<'assigned' | 'self-select'>(room.plan?.mode ?? 'assigned');
  const [allowReturnToMain, setAllowReturnToMain] = useState(room.plan?.allowReturnToMain ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = rooms.find(child => child.id === editingId);
  const assigned = new Set(rooms.flatMap(r => r.members));
  const label = (id: string) => nameOf(id) === id ? 'Name unavailable' : nameOf(id);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(null);
    const result = await writeJson<{ room: SocialRoom }>(`${api}/rooms/${encodeURIComponent(room.slug)}`, 'PATCH', {
      ...(scope === 'settings' ? { settings } : { plan: { expectedVersion: room.plan?.version ?? 0, mode, allowReturnToMain, rooms } }),
    });
    setBusy(false);
    if (!result.ok || !result.data) { setError(result.error ?? 'Configuration could not be saved.'); return; }
    onSaved(result.data.room); onClose();
  }
  const footer = <Inline gap="sm" justify="end"><Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>Cancel</Button>
    <Button type="submit" form={formId} variant="primary" size="sm" disabled={busy || rooms.some(r => !r.name.trim())}>{busy ? 'Saving…' : scope === 'layout' ? 'Save layout' : 'Save configuration'}</Button></Inline>;
  const form = <form id={formId} onSubmit={save} data-testid="hangout-configuration">
      <Stack gap="lg">
        {scope === 'settings' && <Stack gap="md">
          <T size="sm" tone="secondary">Recording changes apply to new calls. Camera defaults apply when people join. Saved rooms and assignments stay with this hangout; temporary changes during a call stay in that call.</T>
          <FormField label="Join with">
            {wiring => <Select {...wiring} size="sm" value={settings.audioOnly ? 'audio' : 'video'} disabled={busy}
              options={[{ value: 'video', label: 'Audio and video' }, { value: 'audio', label: 'Microphones only; cameras off' }]}
              onChange={e => setSettings(s => ({ ...s, audioOnly: e.target.value === 'audio' }))} />}
          </FormField>
          <FormField label="Record and summarize calls" layout="inline" hint="Record new calls and process their dialogue into summaries. People see the recording notice when they join.">
            {wiring => <Switch aria-labelledby={wiring.labelId} size="sm" disabled={busy} checked={settings.recordingEnabled} onChange={recordingEnabled => setSettings(s => ({ ...s, recordingEnabled }))} />}
          </FormField>
        </Stack>}
        {scope === 'layout' && <Stack gap="md">
          <Inline justify="between" gap="sm"><T weight="semibold">Saved rooms</T><Button variant="secondary" size="sm" disabled={busy || rooms.length >= 50}
            onClick={() => { const id = crypto.randomUUID(); setRooms(value => [...value, { id, name: `Room ${value.length + 1}`, members: [] }]); setEditingId(id); }}>Add room</Button></Inline>
          <DataTable data={rooms} keyField={child => child.id} staticRows="Saved room configuration is edited through its explicit Edit room action."
            columns={[{ key: 'name', header: 'Room', render: child => <T size="sm" weight="semibold">{child.name}</T> },
              { key: 'members', header: 'Assigned people', render: child => child.members.length
                ? <Inline gap="xs" wrap>{child.members.map(id => <Chip key={id} size="sm">{label(id)}</Chip>)}</Inline> : <T size="sm" tone="secondary">No one assigned</T> },
              { key: 'actions', header: '', render: child => <Inline gap="sm" justify="end"><Button variant="secondary" size="sm" onClick={() => setEditingId(child.id)}>Edit room</Button>
                <Button variant="ghost" size="sm" aria-label={`Remove ${child.name}`} onClick={() => setRooms(value => value.filter(r => r.id !== child.id))}>Remove</Button></Inline> }]}
            emptyMessage="Everyone starts in the main call. Add a room to save a layout." />
          <FormField label="Joining rooms">
            {wiring => <Select {...wiring} size="sm" value={mode} disabled={busy} onChange={e => setMode(e.target.value as typeof mode)}
              options={[{ value: 'assigned', label: 'Hosts assign people' }, { value: 'self-select', label: 'People choose a room' }]} />}
          </FormField>
          <FormField label="Allow return to main call" layout="inline">
            {wiring => <Switch aria-labelledby={wiring.labelId} size="sm" disabled={busy} checked={allowReturnToMain} onChange={setAllowReturnToMain} />}
          </FormField>
          {rooms.length === 0 && <T size="sm" tone="secondary">Everyone starts in the main call. Add rooms here to reuse a layout, or create temporary rooms during a call.</T>}
          {editing && <Modal open onClose={() => setEditingId(null)} title="Edit room" dialogKind="form" maxWidth={480}
            footer={<Button variant="primary" size="sm" disabled={!editing.name.trim()} onClick={() => setEditingId(null)}>Done</Button>}>
          {[editing].map(child => <Stack key={child.id} gap="sm">
            <Inline gap="sm" align="end"><FormField label="Room name" className="min-w-0 flex-1">
              {wiring => <Input {...wiring} size="sm" value={child.name} maxLength={80} disabled={busy}
                onChange={e => setRooms(value => value.map(r => r.id === child.id ? { ...r, name: e.target.value } : r))} />}
            </FormField><Button variant="ghost" size="sm" disabled={busy} aria-label={`Remove ${child.name}`} onClick={() => setRooms(value => value.filter(r => r.id !== child.id))}>Remove</Button></Inline>
            <FormField label="Assigned people" hint="Assignments reserve a place; they do not mean someone has joined or grant access to a private hangout.">
              {wiring => <PersonPicker {...wiring} size="sm" value="" disabled={busy} placeholder="Find a person to assign"
                people={people.filter(p => !assigned.has(p.userId)).map(p => ({ id: p.userId, name: p.displayName }))}
                onChange={id => { if (id) setRooms(value => value.map(r => r.id === child.id ? { ...r, members: [...r.members, id] } : r)); }} />}
            </FormField>
            <Inline gap="xs" wrap>{child.members.map(id => <Chip key={id} size="sm" onRemove={busy ? undefined : () => setRooms(value => value.map(r => r.id === child.id ? { ...r, members: r.members.filter(member => member !== id) } : r))}
              removeLabel={`Unassign ${label(id)} from ${child.name}`}>{label(id)}</Chip>)}</Inline>
          </Stack>)}
          </Modal>}
        </Stack>}
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
      </Stack>
    </form>;
  return scope === 'layout' ? <Stack gap="lg">{form}{footer}</Stack>
    : <Modal open onClose={busy ? () => {} : onClose} title="Configure hangout" dialogKind="form" maxWidth={640} footer={footer}>{form}</Modal>;
}
