// Getting documents in — the thing the pipeline had no front door for.
//
// Everything upstream of the knowledge base assumed documents arrived by
// crawling a site or by running the synth pipeline from a laptop. There was a
// landing-zone browser buried in a tab on the KB detail page, but it called
// routes that did not exist, so every upload through it failed with a 404.
//
// Two ways in, because they are different problems:
//   - you, here, now: drag files onto this panel
//   - someone else, later, without an account: a share link
//
// Files are posted one per request. A single multi-file request is atomic in
// the worst way — one bad file fails the batch and you cannot tell which
// landed — whereas per-file requests let the list show exactly what happened
// to each.

import { useCallback, useState } from 'react';
import {
  Card, EmptyState, FileUploadDrop, Inline, MetaLine, SectionLabel, Stack, StatusDot,
} from '@connorhoehn/ui-components/shared';

export interface DropTarget {
  /** Registry row id, used for the authenticated upload path. */
  id: string;
  slug: string;
  name: string;
}

type FileState = 'pending' | 'uploading' | 'done' | 'failed';

interface Upload {
  /** Stable identity. Rows used to be addressed by position, and position is
      not stable: dropping a second batch while the first was still uploading
      recomputed `start` from a stale `uploads.length` and overwrote the first
      batch's rows with the second batch's progress. */
  id: string;
  name: string;
  size: number;
  state: FileState;
  error?: string;
}

let _uploadSeq = 0;
const nextUploadId = (): string => `u${++_uploadSeq}`;

const ALLOWED = ['.pdf', '.txt', '.md', '.markdown', '.html', '.htm', '.doc', '.docx', '.csv', '.xls', '.xlsx', '.json'];

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function DocumentDropzone({ target, onUploaded }: {
  target: DropTarget | null;
  /** Fired once a batch settles with at least one success, so the page can re-check sync state. */
  onUploaded?: (count: number) => void;
}) {
  const [uploads, setUploads] = useState<Upload[]>([]);

  const send = useCallback(async (files: File[]) => {
    if (!target || files.length === 0) return;

    const queued = files.map((f) => ({
      id: nextUploadId(), name: f.name, size: f.size, state: 'pending' as FileState,
    }));
    setUploads((prev) => [...prev, ...queued]);

    const patch = (id: string, change: Partial<Upload>) =>
      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...change } : u)));

    let succeeded = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const row = queued[i];
      if (!file || !row) continue;
      patch(row.id, { state: 'uploading' });
      try {
        // Raw body, not multipart: the service has no multipart parser, and a
        // File is already a valid request body.
        const res = await fetch(
          `/api/admin/kb-registry/${target.id}/landing-zone/upload?filename=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        succeeded++;
        patch(row.id, { state: 'done' });
      } catch (err) {
        patch(row.id, { state: 'failed', error: (err as Error).message });
      }
    }
    if (succeeded > 0) onUploaded?.(succeeded);
  }, [target, onUploaded]);

  if (!target) {
    return (
      <Card padding="md">
        <EmptyState
          title="Nowhere to put documents yet"
          description="Uploading needs a knowledge base that exists and is in sync with the account. Resolve the disagreements above first."
        />
      </Card>
    );
  }

  const done = uploads.filter((u) => u.state === 'done').length;
  const failed = uploads.filter((u) => u.state === 'failed').length;

  return (
    <Card padding="none" className="overflow-hidden">
      <Inline gap="sm" align="center" className="px-3.5 py-3 border-b border-border">
        <SectionLabel>ADD DOCUMENTS</SectionLabel>
        <MetaLine size="xs" items={[`into ${target.name}`]} />
        {uploads.length > 0 && (
          <MetaLine
            size="xs"
            className="ml-auto"
            items={[`${done} uploaded${failed > 0 ? `, ${failed} failed` : ''}`]}
          />
        )}
      </Inline>

      {/* The library's drop zone owns the whole interaction — drag state, the
          click-to-choose affordance, keyboard activation and the hidden file
          input. The three lines of guidance that used to sit inside the dashed
          box now sit under it: FileUploadDrop takes one `label`, and copy that
          long belongs beside the control rather than inside its target. */}
      <Stack gap="xs" className="m-3.5">
        <FileUploadDrop
          multiple
          accept={ALLOWED.join(',')}
          label="Drag documents here, or click to choose"
          onFiles={(files) => void send(files)}
        />
        <MetaLine size="xs" items={[ALLOWED.join(' · ')]} />
        <MetaLine
          size="xs"
          items={['Uploaded files sit in storage until the knowledge base syncs — this page will offer that once they land.']}
        />
      </Stack>

      {uploads.length > 0 && (
        <Stack gap="none" className="border-t border-border max-h-52 overflow-y-auto">
          {uploads.map((u) => (
            <Inline key={u.id} gap="sm" align="center" className="px-3.5 py-2 border-b border-border last:border-b-0">
              <StatusDot
                size="sm"
                pulse={u.state === 'uploading'}
                color={
                  u.state === 'done' ? 'var(--color-success)'
                    : u.state === 'failed' ? 'var(--color-danger)'
                    : u.state === 'uploading' ? 'var(--color-warning)'
                    : 'var(--color-text-tertiary)'
                }
              />
              <MetaLine size="sm" className="font-mono truncate flex-1" items={[u.name]} />
              {u.error
                ? <MetaLine size="xs" className="truncate max-w-[45%] text-danger" items={[u.error]} />
                : <MetaLine size="xs" className="shrink-0" items={[bytes(u.size)]} />}
            </Inline>
          ))}
        </Stack>
      )}
    </Card>
  );
}
