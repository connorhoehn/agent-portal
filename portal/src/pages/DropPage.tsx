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

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';

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
interface Upload { name: string; size: number; state: FileState; error?: string }

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

export default function DropPage() {
  const { token = '' } = useParams();
  const [link, setLink] = useState<LinkView | null>(null);
  const [loading, setLoading] = useState(true);
  const [invalid, setInvalid] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/drop/${encodeURIComponent(token)}`);
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
    const start = uploads.length;
    setUploads((prev) => [
      ...prev,
      ...files.map((f) => ({ name: f.name, size: f.size, state: 'pending' as FileState })),
    ]);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) continue;
      const idx = start + i;
      setUploads((prev) => prev.map((u, j) => (j === idx ? { ...u, state: 'uploading' } : u)));
      try {
        const res = await fetch(
          `/api/drop/${encodeURIComponent(token)}/upload?filename=${encodeURIComponent(file.name)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': file.type || 'application/octet-stream' },
            body: file,
          },
        );
        if (!res.ok) {
          const body = await res.json().catch(() => ({})) as { error?: string };
          throw new Error(body.error ?? `Upload failed (${res.status})`);
        }
        setUploads((prev) => prev.map((u, j) => (j === idx ? { ...u, state: 'done' } : u)));
      } catch (err) {
        setUploads((prev) => prev.map((u, j) => (
          j === idx ? { ...u, state: 'failed', error: (err as Error).message } : u
        )));
      }
    }
    // Re-read the link so the remaining-files count reflects what just landed.
    try {
      const res = await fetch(`/api/drop/${encodeURIComponent(token)}`);
      if (res.ok) setLink(await res.json() as LinkView);
    } catch { /* the uploads already reported themselves */ }
  }, [token, uploads.length]);

  const shell = (children: React.ReactNode) => (
    <div className="min-h-screen bg-bg flex items-start justify-center px-4 py-14">
      <div className="w-full max-w-xl">{children}</div>
    </div>
  );

  if (loading) {
    return shell(<div className="text-[13px] text-text-tertiary">Checking this link…</div>);
  }

  if (invalid || !link) {
    return shell(
      <div className="rounded-lg border border-border bg-surface p-6">
        <div className="text-[15px] font-bold text-text-primary">This link isn’t valid</div>
        <div className="text-[13px] text-text-secondary mt-2 leading-relaxed">
          It may have been mistyped, or turned off. Ask whoever sent it for a new one — nothing you can do
          on this page will fix it.
        </div>
      </div>,
    );
  }

  if (link.status !== 'live') {
    return shell(
      <div className="rounded-lg border border-border bg-surface p-6">
        <div className="text-[15px] font-bold text-text-primary">{DEAD_MESSAGE[link.status]}</div>
        <div className="text-[13px] text-text-secondary mt-2 leading-relaxed">
          It was for <strong>{link.label}</strong>. Ask whoever sent it for a new one.
        </div>
      </div>,
    );
  }

  const done = uploads.filter((u) => u.state === 'done').length;

  return shell(
    <div className="rounded-lg border border-border bg-surface overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <div className="text-[15px] font-bold text-text-primary">Add documents</div>
        <div className="text-[13px] text-text-secondary mt-1 leading-snug">
          {link.label}
        </div>
      </div>

      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); void send(Array.from(e.dataTransfer.files)); }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        className={`m-5 rounded-lg border-2 border-dashed px-4 py-10 text-center cursor-pointer transition-colors ${
          dragging ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50'
        }`}
      >
        <div className="text-[14px] font-semibold text-text-primary">
          {dragging ? 'Drop to upload' : 'Drag files here, or click to choose'}
        </div>
        <div className="text-[11px] text-text-tertiary mt-2">
          {link.allowedExtensions.join(' · ')}
        </div>
        <div className="text-[11px] text-text-tertiary mt-1">
          Up to {link.filesRemaining} more {link.filesRemaining === 1 ? 'file' : 'files'} · {bytes(link.maxBytes)} each
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={link.allowedExtensions.join(',')}
          className="hidden"
          onChange={(e) => { void send(Array.from(e.target.files ?? [])); e.target.value = ''; }}
        />
      </div>

      {uploads.length > 0 && (
        <div className="border-t border-border">
          {uploads.map((u, i) => (
            <div key={`${u.name}-${i}`} className="px-5 py-2.5 border-b border-border last:border-b-0 flex items-center gap-2.5">
              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                u.state === 'done' ? 'bg-success'
                  : u.state === 'failed' ? 'bg-danger'
                  : u.state === 'uploading' ? 'bg-warning animate-pulse'
                  : 'bg-text-tertiary'
              }`} />
              <span className="text-[12px] text-text-primary truncate flex-1">{u.name}</span>
              {u.error
                ? <span className="text-[11px] text-danger truncate max-w-[50%]" title={u.error}>{u.error}</span>
                : <span className="text-[11px] text-text-tertiary shrink-0">{bytes(u.size)}</span>}
            </div>
          ))}
          {done > 0 && (
            <div className="px-5 py-3 text-[12px] text-text-secondary leading-snug">
              {done} {done === 1 ? 'file is' : 'files are'} in. Someone on the team still has to index them
              before they can be searched — you don’t need to do anything else.
            </div>
          )}
        </div>
      )}
    </div>,
  );
}
