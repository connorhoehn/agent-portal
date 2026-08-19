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

import { useCallback, useRef, useState } from 'react';
import { Card } from '@connorhoehnslalom/ui-components/shared';

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
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void send(Array.from(e.dataTransfer.files));
  }, [send]);

  if (!target) {
    return (
      <Card padding="md">
        <div className="text-[13px] font-semibold text-text-primary">Nowhere to put documents yet</div>
        <div className="text-[12px] text-text-secondary mt-1 leading-snug">
          Uploading needs a knowledge base that exists and is in sync with the account. Resolve the
          disagreements above first.
        </div>
      </Card>
    );
  }

  const done = uploads.filter((u) => u.state === 'done').length;
  const failed = uploads.filter((u) => u.state === 'failed').length;

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">ADD DOCUMENTS</span>
        <span className="text-[11px] text-text-tertiary">
          into <span className="font-mono">{target.name}</span>
        </span>
        <div className="flex-1" />
        {uploads.length > 0 && (
          <span className="text-[11px] text-text-tertiary">
            {done} uploaded{failed > 0 ? `, ${failed} failed` : ''}
          </span>
        )}
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        className={`m-3.5 rounded-lg border-2 border-dashed px-4 py-7 text-center cursor-pointer transition-colors ${
          dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
        }`}
      >
        <div className="text-[13px] font-semibold text-text-primary">
          {dragging ? 'Drop to upload' : 'Drag documents here, or click to choose'}
        </div>
        <div className="text-[11px] text-text-tertiary mt-1.5">
          {ALLOWED.join(' · ')}
        </div>
        <div className="text-[11px] text-text-tertiary mt-1">
          Uploaded files sit in storage until the knowledge base syncs — this page will offer that once they land.
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ALLOWED.join(',')}
          className="hidden"
          onChange={(e) => {
            void send(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </div>

      {uploads.length > 0 && (
        <div className="border-t border-border max-h-52 overflow-y-auto">
          {uploads.map((u) => (
            <div key={u.id} className="px-3.5 py-2 border-b border-border last:border-b-0 flex items-center gap-2.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                u.state === 'done' ? 'bg-success'
                  : u.state === 'failed' ? 'bg-danger'
                  : u.state === 'uploading' ? 'bg-warning animate-pulse'
                  : 'bg-text-tertiary'
              }`} />
              <span className="text-[12px] text-text-primary font-mono truncate flex-1">{u.name}</span>
              {u.error
                ? <span className="text-[11px] text-danger truncate max-w-[45%]" title={u.error}>{u.error}</span>
                : <span className="text-[11px] text-text-tertiary shrink-0">{bytes(u.size)}</span>}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
