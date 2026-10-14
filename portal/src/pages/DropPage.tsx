// The page a share link opens — for someone who does not work here.
//
// Rendered outside the app shell on purpose: no nav, no tenant switcher, no
// masquerade control, nothing that implies an account. The person opening this
// has one job and should see one thing.
//
// It also tells the truth when the link is dead. A revoked or expired link
// that renders an upload box and fails on submit wastes the recipient's time
// and gives them nothing to act on — they cannot fix it, so the page says who
// can.

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useParams } from 'react-router';
import {
  Banner, Card, CardHeader, ErrorState, FileUploadDrop, Inline, LoadingState,
  MetaLine, Stack, StatusDot, T,
} from '@connorhoehnslalom/ui-components/shared';

interface LinkView {
  label: string;
  destination: string;
  status: 'live' | 'expired' | 'revoked' | 'exhausted';
  expiresAt: string;
  filesRemaining: number;
  maxBytes: number;
  allowedExtensions: string[];
}

type FileState = 'pending' | 'uploading' | 'done' | 'failed';
interface Upload { id: string; name: string; size: number; state: FileState; error?: string }

let _uploadSeq = 0;
const nextUploadId = (): string => `u${++_uploadSeq}`;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const DEAD_MESSAGE: Record<string, string> = {
  expired: 'This link has expired.',
  revoked: 'This link has been turned off.',
  exhausted: 'This link has already received all the files it allows.',
};

const STATE_TONE: Record<FileState, string> = {
  done: 'var(--color-success)',
  failed: 'var(--color-danger)',
  uploading: 'var(--color-warning)',
  pending: 'var(--color-text-tertiary)',
};

const STATE_LABEL: Record<FileState, string> = {
  done: 'uploaded',
  failed: 'failed',
  uploading: 'uploading',
  pending: 'queued',
};

function shell(children: ReactNode) {
  return (
    <Stack align="center" className="min-h-screen bg-bg px-4 py-14">
      <Stack className="w-full max-w-xl">{children}</Stack>
    </Stack>
  );
}

export default function DropPage() {
  const { token = '' } = useParams();
  const [link, setLink] = useState<LinkView | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/drop/${encodeURIComponent(token)}`, { credentials: 'include' });
        if (!res.ok) { if (!cancelled) setInvalid(true); return; }
        const body = await res.json() as LinkView;
        if (!cancelled) setLink(body);
      } catch {
        if (!cancelled) setInvalid(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const send = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    // Positional indexing broke when a second batch was dropped mid-upload:
    // `start` came from a stale length and the new rows overwrote the old.
    const queued = files.map((f) => ({
      id: nextUploadId(), name: f.name, size: f.size, state: 'pending' as FileState,
    }));
    setUploads((prev) => [...prev, ...queued]);

    const patch = (id: string, change: Partial<Upload>) =>
      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...change } : u)));

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const row = queued[i];
      if (!file || !row) continue;

      // Refuse locally when the size is already known to be over. Sending a
      // 40 MB file across a slow connection only to be told the limit was
      // 25 MB wastes the upload and reads as a failure rather than a rule.
      const cap = link?.maxBytes ?? Infinity;
      if (file.size > cap) {
        patch(row.id, {
          state: 'failed',
          error: `${bytes(file.size)} — this link allows ${bytes(cap)} per file`,
        });
        continue;
      }

      patch(row.id, { state: 'uploading' });
      try {
        const res = await fetch(
          `/api/drop/${encodeURIComponent(token)}/upload?filename=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `Upload failed (${res.status})`);
        }
        patch(row.id, { state: 'done' });
      } catch (err) {
        patch(row.id, { state: 'failed', error: (err as Error).message });
      }
    }
    // Re-read the link so the remaining-files count reflects what just landed.
    try {
      const res = await fetch(`/api/drop/${encodeURIComponent(token)}`, { credentials: 'include' });
      if (res.ok) setLink(await res.json() as LinkView);
    } catch { /* the uploads already reported themselves */ }
  }, [token, link?.maxBytes]);

  if (loading) {
    return shell(<LoadingState label="Checking this link…" />);
  }

  if (invalid || !link) {
    return shell(
      <Card>
        <ErrorState
          icon={null}
          title="This link isn’t valid"
          body="It may have been mistyped, or turned off. Ask whoever sent it for a new one — nothing you can do on this page will fix it."
        />
      </Card>,
    );
  }

  if (link.status !== 'live') {
    return shell(
      <Card>
        <ErrorState
          icon={null}
          title={DEAD_MESSAGE[link.status] ?? 'This link is no longer active.'}
          description={<>It was for <strong>{link.label}</strong>. Ask whoever sent it for a new one.</>}
        />
      </Card>,
    );
  }

  const done = uploads.filter((u) => u.state === 'done').length;

  return shell(
    <Card padding="none">
      <CardHeader inset title="Add documents" subtitle={link.label} />

      <Stack gap="sm" className="p-5">
        <FileUploadDrop
          accept={link.allowedExtensions.join(',')}
          multiple
          onFiles={(files) => { void send(files); }}
          label="Drag files here, or click to choose"
        />
        <MetaLine
          items={[
            link.allowedExtensions.join(' · '),
            `Up to ${link.filesRemaining} more ${link.filesRemaining === 1 ? 'file' : 'files'}`,
            `${bytes(link.maxBytes)} each`,
          ]}
        />
      </Stack>

      {uploads.length > 0 && (
        <Stack gap="none" className="border-t border-border">
          {uploads.map((u) => (
            <Inline
              key={u.id} gap="sm" align="center"
              className="px-5 py-2.5 border-b border-border last:border-b-0"
            >
              <StatusDot
                color={STATE_TONE[u.state]}
                pulse={u.state === 'uploading'}
                title={STATE_LABEL[u.state]}
                aria-label={STATE_LABEL[u.state]}
              />
              <T size="xs" className="text-text-primary truncate flex-1">{u.name}</T>
              {u.error
                ? <T size="xs" className="text-danger truncate max-w-[50%]" title={u.error}>{u.error}</T>
                : <T size="xs" className="text-text-tertiary shrink-0">{bytes(u.size)}</T>}
            </Inline>
          ))}
          {done > 0 && (
            <Banner variant="success" className="m-0 rounded-none border-0">
              {done} {done === 1 ? 'file is' : 'files are'} in. Someone on the team still has to index them
              before they can be searched — you don’t need to do anything else.
            </Banner>
          )}
        </Stack>
      )}
    </Card>,
  );
}
