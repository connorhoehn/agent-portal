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

import { plural } from '../../lib/plural';
import { useCallback, useState } from 'react';
import {
  Button, Card, Chip, EntityCell, FormField, Inline, Input, MetaLine, SectionLabel, Select, Stack,
} from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';

interface UploadLink {
  id: string;
  kbSlug: string;
  label: string;
  createdBy: string | null;
  createdByName?: string | null;
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

  // `labelId` comes out of every FormField wiring bag — it is not a DOM prop
  // and spreading it onto an input makes React warn. Queued against the library.
  return (
    <Card padding="none" className="overflow-hidden">
      <Inline gap="sm" align="center" className="px-3.5 py-3 border-b border-border">
        <SectionLabel>SHARE LINKS</SectionLabel>
        <MetaLine size="xs" items={['let someone add documents without an account']} />
        <Button variant="secondary" size="sm" className="ml-auto" onClick={() => setCreating((v) => !v)}>
          {creating ? 'Cancel' : '+ New link'}
        </Button>
      </Inline>

      {/* The token, once. */}
      {fresh && (
        <Stack gap="sm" className="px-3.5 py-3 border-b border-border bg-primary/5">
          <EntityCell label={`Link for “${fresh.label}” — copy it now`} className="min-w-0" />
          <MetaLine
            size="xs"
            className="leading-snug"
            items={['This is the only time it is shown. The server keeps a hash, not the link, so it cannot be looked up again — make a new one if you lose it.']}
          />
          <Inline gap="sm">
            <Input
              readOnly
              mono
              size="sm"
              className="flex-1"
              value={fresh.url}
              onFocus={(e) => e.target.select()}
              aria-label="Share link"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(fresh.url);
                toastSuccess(null, 'Copied', 'The link is on your clipboard.');
              }}
            >
              Copy
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setFresh(null)}>Done</Button>
          </Inline>
        </Stack>
      )}

      {creating && (
        <Inline gap="md" align="end" wrap className="px-3.5 py-3 border-b border-border">
          <FormField label="Who is this for" className="flex-1 min-w-[220px]">
            {({ labelId: _l, ...w }) => (
              <Input
                {...w}
                size="sm"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Finance — Q3 vendor contracts"
              />
            )}
          </FormField>
          <FormField label="Expires">
            {({ labelId: _l, ...w }) => (
              <Select
                {...w}
                size="sm"
                value={String(hours)}
                onChange={(e) => setHours(Number(e.target.value))}
                options={[
                  { value: '24', label: '24 hours' },
                  { value: '72', label: '3 days' },
                  { value: '168', label: '7 days' },
                  { value: '720', label: '30 days' },
                ]}
              />
            )}
          </FormField>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !label.trim()}
            onClick={() => void create()}
          >
            {busy ? 'creating…' : 'Create link'}
          </Button>
          {/* Naming it is required server-side too — an unlabelled link is
              untraceable the moment there is more than one. */}
          <MetaLine
            size="xs"
            className="w-full"
            items={['Anyone with the link can upload up to 25 files of 25 MB each into this knowledge base, until it expires or you revoke it.']}
          />
        </Inline>
      )}

      {links.length === 0 ? (
        <MetaLine
          size="sm"
          className="px-3.5 py-4"
          items={['No share links. Create one to let someone drop documents in without giving them an account.']}
        />
      ) : (
        links.map((l) => (
          <Inline key={l.id} gap="md" align="center" className="px-3.5 py-2.5 border-b border-border last:border-b-0">
            <Chip size="xs" className={`shrink-0 ${STATUS_TONE[l.status]}`}>{l.status}</Chip>
            <Stack gap="none" className="flex-1 min-w-0">
              <SectionLabel className="truncate">{l.label}</SectionLabel>
              <MetaLine
                size="xs"
                items={[
                  `${l.filesUsed}/${plural(l.maxFiles, 'file')}`,
                  l.lastUsedAt ? `last used ${when(l.lastUsedAt)}` : 'never used',
                  l.status === 'live' ? `expires ${when(l.expiresAt)}` : null,
                  l.createdBy ? `by ${l.createdByName ?? l.createdBy}` : null,
                ]}
              />
            </Stack>
            {l.status === 'live' && (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => void revoke(l.id, l.label)}
              >
                Revoke
              </Button>
            )}
          </Inline>
        ))
      )}
    </Card>
  );
}
