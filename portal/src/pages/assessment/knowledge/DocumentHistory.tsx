import { useEffect, useState, type ComponentProps } from 'react';
import { CanvasDocumentView, VersionHistoryPanel } from '@connorhoehnslalom/ui-components/doc-editor';
import { useVersionHistory } from '@connorhoehnslalom/ui-components/hooks';
import { Button, ConfirmDialog, InlineAlert, LoadingState, Modal, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useCanvasDocument, useGateway } from '@connorhoehnslalom/realtime-modules/client';
import { DocumentContextPanel } from './ExplorerFrame';
import type * as Y from 'yjs';

function BinaryVersionPreview({ ydoc, extensions }: { ydoc: Y.Doc; extensions: ComponentProps<typeof CanvasDocumentView>['extensions'] }) {
  const canvas = useCanvasDocument({ ydoc });
  return canvas.isCanvas && canvas.body ? <CanvasDocumentView isCanvas body={canvas.body} ydoc={ydoc} provider={null}
    user={{ name: 'Version preview', color: 'teal' }} editable={false} extensions={extensions} showRuler showStatusBar paginate />
    : <InlineAlert tone="warning">This historical snapshot predates rich document migration. Restore is unavailable for this version.</InlineAlert>;
}

export function DocumentHistory({ documentId, open, onClose, extensions, onSave, onRestore, pending }: {
  documentId: string; open: boolean; onClose: () => void;
  extensions: ComponentProps<typeof CanvasDocumentView>['extensions'];
  onSave?: (name: string) => Promise<void>; onRestore?: (timestamp: number) => Promise<void>; pending: boolean;
}) {
  const gateway = useGateway();
  const history = useVersionHistory({ channel: `doc:${documentId}`, sendMessage: gateway.sendMessage, onMessage: gateway.onMessage });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  useEffect(() => { if (open && gateway.connectionState === 'connected') history.fetchVersions(); }, [open, gateway.connectionState, history.fetchVersions]);
  async function save(name: string) {
    if (!onSave || pending || busy) return;
    setBusy(true); setError(null);
    try { await onSave(name); history.fetchVersions(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The version could not be saved.'); }
    finally { setBusy(false); }
  }
  async function restore() {
    if (!onRestore || pending || busy || history.previewTimestamp == null) return;
    setBusy(true); setError(null);
    try { await onRestore(history.previewTimestamp); history.clearPreview(); history.fetchVersions(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The version could not be restored.'); }
    finally { setBusy(false); setConfirmRestore(false); }
  }
  return <>
    <DocumentContextPanel id="history">
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <VersionHistoryPanel versions={history.versions} loading={history.loading} previewTimestamp={history.previewTimestamp}
        onFetch={history.fetchVersions} onPreview={history.previewVersion} onClearPreview={history.clearPreview} onClose={onClose}
        onSaveVersion={onSave && !pending && !busy ? name => void save(name) : undefined}
        onClearCompare={history.clearCompare} compareSections={null} compareTimestamp={null} currentSections={[]} />
    </DocumentContextPanel>
    <Modal open={history.previewTimestamp !== null} onClose={() => { if (!busy) history.clearPreview(); }} title="Saved document version" maxWidth={1200}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={history.clearPreview}>Close preview</Button>
        {onRestore && <Button variant="secondary" disabled={pending || busy || !history.previewDoc || Number(history.previewDoc.getMap('meta').get('schemaVersion')) < 2}
          onClick={() => setConfirmRestore(true)}>Restore this version…</Button>}
      </>}>
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      <Stack gap="none" className="h-[65vh] min-h-0 overflow-auto">
        {history.previewDoc ? <BinaryVersionPreview ydoc={history.previewDoc} extensions={extensions} /> : <LoadingState label="Loading saved binary snapshot…" />}
      </Stack>
    </Modal>
    <ConfirmDialog open={confirmRestore} title="Restore this saved version?" tone="caution" confirmLabel={busy ? 'Restoring…' : 'Restore version'}
      body="This replaces the document content for everyone. A checkpoint of the current content is saved first. Existing discussion records remain separate from the restored content."
      onCancel={() => { if (!busy) setConfirmRestore(false); }} onConfirm={() => void restore()} />
  </>;
}
