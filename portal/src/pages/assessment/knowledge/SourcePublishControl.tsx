import { useEffect, useRef, useState } from 'react';
import { Button, DiffViewer, Inline, InlineAlert, LoadingState, Modal, Stack } from '@connorhoehnslalom/ui-components/shared';
import { sendJson } from '../../../lib/writeJson';

interface SourcePreview {
  page_id: string; has_changes: boolean; lines: Array<{ kind: 'same' | 'added' | 'removed'; text: string }>;
  added: number; removed: number; source_revision: string; canvas_version: string;
  projectionHash: string; sourceRevision: string;
}
interface SourcePublishResult { published: boolean; new_version: number; summary: string; reconciliation_needed?: boolean; warning?: string }
function unifiedDiff(preview: SourcePreview): string {
  const before = preview.lines.filter(line => line.kind !== 'added').length;
  const after = preview.lines.filter(line => line.kind !== 'removed').length;
  return ['diff --git a/document.md b/document.md', '--- a/document.md', '+++ b/document.md',
    `@@ -1,${before} +1,${after} @@`, ...preview.lines.map(line => `${line.kind === 'added' ? '+' : line.kind === 'removed' ? '-' : ' '}${line.text}`)].join('\n');
}

/** The source service projects durable canvas bytes; the browser never supplies publish content. */
export function SourcePublishControl({ sourceId, disabled, changeSequence, onPublished }: {
  sourceId: string; disabled: boolean; changeSequence: number; onPublished: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<SourcePreview | null>(null);
  const [previewSequence, setPreviewSequence] = useState<number | null>(null);
  const [pending, setPending] = useState<'preview' | 'publish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SourcePublishResult | null>(null);
  const currentSequence = useRef(changeSequence);
  currentSequence.current = changeSequence;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const stale = previewSequence !== changeSequence;
  async function review() {
    if (disabled || pending) return;
    setOpen(true); setPending('preview'); setError(null); setResult(null); setPreview(null);
    const sequence = currentSequence.current;
    try {
      const response = await sendJson<SourcePreview>('/api/assessment/knowledge/source/preview', 'POST', { id: sourceId });
      if (mounted.current) { setPreview(response); setPreviewSequence(sequence); }
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The source changes could not be loaded.'); }
    finally { if (mounted.current) setPending(null); }
  }
  async function publish() {
    if (!preview || stale || disabled || pending || !preview.has_changes) return;
    setPending('publish'); setError(null);
    try {
      const response = await sendJson<SourcePublishResult>('/api/assessment/knowledge/source/publish', 'POST', {
        id: sourceId, projectionHash: preview.projectionHash, sourceRevision: preview.sourceRevision,
      });
      if (!mounted.current) return;
      setResult(response);
      if (response.published) onPublished();
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The source could not be published.'); }
    finally { if (mounted.current) setPending(null); }
  }
  return <>
    <Button size="sm" variant="secondary" disabled={disabled || !!pending} onClick={() => void review()}>Review &amp; publish</Button>
    <Modal open={open} onClose={() => { if (!pending) setOpen(false); }} title={result?.published ? 'Published to source' : 'Review source changes'}
      footer={<Inline gap="sm">
        <Button size="sm" variant="ghost" disabled={!!pending} onClick={() => setOpen(false)}>{result ? 'Close' : 'Cancel'}</Button>
        {!result && <Button size="sm" variant="secondary" disabled={disabled || !!pending} onClick={() => void review()}>Refresh preview</Button>}
        {!result && <Button size="sm" variant="primary" disabled={disabled || !!pending || !preview?.has_changes || stale} onClick={() => void publish()}>{pending === 'publish' ? 'Publishing…' : 'Publish to source'}</Button>}
      </Inline>}>
      <Stack gap="md">
        {error && <InlineAlert tone="error">{error}</InlineAlert>}
        {pending === 'preview' && <LoadingState label="Comparing saved draft with source…" />}
        {result ? <InlineAlert tone={result.reconciliation_needed ? 'warning' : 'success'}>{result.warning ?? result.summary}</InlineAlert> : preview && <>
          {stale && <InlineAlert tone="warning">The document changed after this preview. Refresh it before publishing.</InlineAlert>}
          {!preview.has_changes ? <InlineAlert tone="info">The saved draft matches the source.</InlineAlert> : <>
            <Inline gap="sm">{preview.added} added · {preview.removed} removed</Inline>
            <DiffViewer diff={unifiedDiff(preview)} maxLinesPerFile={1000} />
          </>}
        </>}
      </Stack>
    </Modal>
  </>;
}
