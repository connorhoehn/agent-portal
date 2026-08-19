// Share links — letting someone add documents without giving them access.
//
// The instinct is to hand out temporary AWS credentials. Those are bearer
// credentials carrying everything the role can do: they cannot be scoped per
// recipient, cannot be revoked one at a time without rotating the role, and
// need the recipient to configure an AWS SDK rather than open a browser.
//
// A link is narrower in every direction. The recipient receives a URL and no
// credential of any kind — the middleware holds the only AWS identity and
// checks each upload against this link's own limits. Revoking is one click,
// and because every link is labelled you can answer "where did this file come
// from" later, which anonymous credentials can never tell you.

import { useCallback, useState } from 'react';
import { Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';

interface UploadLink {
  id: string;
  kbSlug: string;
  label: string;
  createdBy: string | null;
  expiresAt: string;
  maxFiles: number;
  maxBytes: number;
  filesUsed: number;
  bytesUsed: number;
  createdAt: string;
  lastUsedAt: string | null;
  status: 'live' | 'expired' | 'revoked' | 'exhausted';
}

const STATUS_TONE: Record<UploadLink['status'], string> = {
  live: 'bg-success-bg text-success',
  expired: 'bg-surface-hover text-text-tertiary',
  revoked: 'bg-surface-hover text-text-tertiary',
  exhausted: 'bg-warning-bg text-warning',
};

function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  const abs = Math.abs(mins);
  const unit = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`;
  return mins >= 0 ? `in ${unit}` : `${unit} ago`;
}

export function ShareLinks({ kbSlug }: { kbSlug: string | null }) {
  const { data, refresh } = useFetch<{ links: UploadLink[] }>(
    kbSlug ? `/api/admin/kb-registry/upload-links?kbSlug=${encodeURIComponent(kbSlug)}` : null,
    60_000,
  );
  const [creating, setCreating] = useState(false);
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState(72);
  const [busy, setBusy] = useState(false);

  // Shown once, then gone — the server stores only a hash, so there is no
  // second chance to read it and nowhere to look it up.
  const [fresh, setFresh] = useState<{ url: string; label: string } | null>(null);

  const create = useCallback(async () => {
    if (!kbSlug || !label.trim()) return;
    setBusy(true);
    const tid = toastPending('Creating upload link', label);
    try {
      const res = await fetch('/api/admin/kb-registry/upload-links', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kbSlug, label: label.trim(), expiresInHours: hours }),
      });
      const body = await res.json() as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error ?? `HTTP ${res.status}`);
      setFresh({ url: `${window.location.origin}/drop/${body.token}`, label: label.trim() });
      toastSuccess(tid, 'Link created', 'Copy it now — it is not recoverable.');
      setLabel('');
      setCreating(false);
      refresh();
    } catch (err) {
      toastError(tid, 'Could not create link', (err as Error).message);
    } finally { setBusy(false); }
  }, [kbSlug, label, hours, refresh]);

  const revoke = useCallback(async (id: string, name: string) => {
    const tid = toastPending('Revoking link', name);
    try {
      const res = await fetch(`/api/admin/kb-registry/upload-links/${id}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, 'Link revoked', `${name} can no longer upload.`);
      refresh();
    } catch (err) {
      toastError(tid, 'Could not revoke', (err as Error).message);
    }
  }, [refresh]);

  if (!kbSlug) return null;
  const links = data?.links ?? [];

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">SHARE LINKS</span>
        <span className="text-[11px] text-text-tertiary">
          let someone add documents without an account
        </span>
        <div className="flex-1" />
        <button
          onClick={() => setCreating((v) => !v)}
          className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors"
        >
          {creating ? 'Cancel' : '+ New link'}
        </button>
      </div>

      {/* The token, once. */}
      {fresh && (
        <div className="px-3.5 py-3 border-b border-border bg-primary/5">
          <div className="text-[12px] font-semibold text-text-primary">
            Link for “{fresh.label}” — copy it now
          </div>
          <div className="text-[11px] text-text-secondary mt-1 mb-2 leading-snug">
            This is the only time it is shown. The server keeps a hash, not the link, so it cannot be
            looked up again — make a new one if you lose it.
          </div>
          <div className="flex gap-2">
            <input
              readOnly
              value={fresh.url}
              onFocus={(e) => e.target.select()}
              className="flex-1 px-2 py-1.5 rounded-md border border-border bg-surface text-[11px] font-mono text-text-primary"
            />
            <button
              onClick={() => {
                void navigator.clipboard.writeText(fresh.url);
                toastSuccess(null, 'Copied', 'The link is on your clipboard.');
              }}
              className="px-2.5 py-1.5 rounded-md border-none bg-primary text-white text-[11px] font-semibold cursor-pointer"
            >
              Copy
            </button>
            <button
              onClick={() => setFresh(null)}
              className="px-2 py-1.5 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {creating && (
        <div className="px-3.5 py-3 border-b border-border flex flex-wrap items-end gap-2.5">
          <label className="flex-1 min-w-[220px]">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
              Who is this for
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Finance — Q3 vendor contracts"
              className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
            />
          </label>
          <label>
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
              Expires
            </span>
            <select
              value={hours}
              onChange={(e) => setHours(Number(e.target.value))}
              className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
            >
              <option value={24}>24 hours</option>
              <option value={72}>3 days</option>
              <option value={168}>7 days</option>
              <option value={720}>30 days</option>
            </select>
          </label>
          <button
            disabled={busy || !label.trim()}
            onClick={() => void create()}
            className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
          >
            {busy ? 'creating…' : 'Create link'}
          </button>
          {/* Naming it is required server-side too — an unlabelled link is
              untraceable the moment there is more than one. */}
          <div className="w-full text-[11px] text-text-tertiary">
            Anyone with the link can upload up to 25 files of 25 MB each into this knowledge base, until it
            expires or you revoke it.
          </div>
        </div>
      )}

      {links.length === 0 ? (
        <div className="px-3.5 py-4 text-[12px] text-text-tertiary">
          No share links. Create one to let someone drop documents in without giving them an account.
        </div>
      ) : (
        links.map((l) => (
          <div key={l.id} className="px-3.5 py-2.5 border-b border-border last:border-b-0 flex items-center gap-3">
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded shrink-0 ${STATUS_TONE[l.status]}`}>
              {l.status}
            </span>
            <div className="flex-1 min-w-0">
              <div className="text-[12px] font-semibold text-text-primary truncate">{l.label}</div>
              <div className="text-[11px] text-text-tertiary">
                {l.filesUsed}/{l.maxFiles} files
                {l.lastUsedAt ? ` · last used ${when(l.lastUsedAt)}` : ' · never used'}
                {l.status === 'live' ? ` · expires ${when(l.expiresAt)}` : ''}
                {l.createdBy ? ` · by ${l.createdBy}` : ''}
              </div>
            </div>
            {l.status === 'live' && (
              <button
                onClick={() => void revoke(l.id, l.label)}
                className="shrink-0 px-2 py-1 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer hover:border-danger hover:text-danger transition-colors"
              >
                Revoke
              </button>
            )}
          </div>
        ))
      )}
    </Card>
  );
}
