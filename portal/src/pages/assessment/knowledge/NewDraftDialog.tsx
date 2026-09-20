import { useEffect, useState } from 'react';
import { Button, InlineAlert, Input, Modal, Stack } from '@connorhoehnslalom/ui-components/shared';
import { sendJson } from '../../../lib/writeJson';

export interface DraftDestination { sectionKey: string; parentId?: string | null; sourceParentId?: string; parentTitle?: string }
/** A blank rich page; templates and other authoring surfaces are not offered without their backend contract. */
export function NewDraftDialog({ destination, onClose, onCreated }: {
  destination: DraftDestination | null; onClose: () => void; onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setTitle(''); setError(null); setPending(false); }, [destination]);
  async function create() {
    if (!destination || !title.trim() || pending) return;
    setPending(true); setError(null);
    try {
      const { parentTitle: _parentTitle, ...target } = destination;
      const result = await sendJson<{ ok: boolean; id: string }>('/api/assessment/knowledge/doc/create', 'POST', { title: title.trim(), ...target });
      if (!result.ok || !result.id) throw new Error('The server did not confirm the new page.');
      onCreated(result.id);
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The page could not be created.'); }
    finally { setPending(false); }
  }
  return <Modal open={!!destination} onClose={() => { if (!pending) onClose(); }} title={destination?.parentTitle ? `New child draft · ${destination.parentTitle}` : 'New page'}
    footer={<>
      <Button variant="ghost" size="sm" disabled={pending} onClick={onClose}>Cancel</Button>
      <Button variant="primary" size="sm" disabled={pending || !title.trim()} onClick={() => void create()}>{pending ? 'Creating…' : 'Create draft'}</Button>
    </>}>
    <Stack gap="sm">
      <Input aria-label="Page title" placeholder="Page title" value={title} onChange={event => setTitle(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void create(); } }} />
      {destination?.sourceParentId && <InlineAlert tone="info">This creates a local workspace draft for that source parent. The remote page is created only when you publish.</InlineAlert>}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
    </Stack>
  </Modal>;
}
