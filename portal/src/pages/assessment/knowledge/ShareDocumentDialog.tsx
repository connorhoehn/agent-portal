import { useEffect, useState } from 'react';
import { Button, FormField, InlineAlert, Input, Modal, Stack, T } from '@connorhoehnslalom/ui-components/shared';

/** Knowledge pages inherit source-space/role access; a link does not grant access. */
export function ShareDocumentDialog({ document, onClose }: {
  document: { id: string; title: string; source: string } | null;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setCopied(false); setError(null); }, [document]);
  const url = new URL(window.location.href);
  if (document) url.searchParams.set('doc', document.id);
  url.searchParams.delete('view');
  url.hash = '';
  async function copy() {
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true); setError(null);
    } catch { setError('Could not copy the link. Select it below and copy it with your keyboard.'); }
  }
  return <Modal open={!!document} onClose={onClose} title={`Share ${document?.title ?? 'document'}`} maxWidth={480}
    backdropTestId="share-document-dialog" footer={<>
      <Button variant="ghost" onClick={onClose}>Done</Button>
      <Button variant="primary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy link'}</Button>
    </>}>
    <Stack gap="md">
      <T>People with access to {document?.source} can open this document.</T>
      <FormField label="Document link">
        {wiring => <Input {...wiring} readOnly value={url.toString()} aria-label="Document link" onFocus={event => event.target.select()} />}
      </FormField>
      <T className="text-text-secondary">Access is managed by workspace roles and the source space. Copying this link keeps the current permissions.</T>
      {copied && <T role="status">Link copied.</T>}
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
    </Stack>
  </Modal>;
}
