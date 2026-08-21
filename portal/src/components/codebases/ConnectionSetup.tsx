// GitHub connection setup, on the Codebases page.
//
// Linking a private repository has always needed a credential, and until now
// the only place to create one was Knowledge → Sources — a detour through
// ingestion for what is really a codebase decision. This card puts the PAT
// flow where the repositories are.
//
// The secret goes one way. The PAT is posted to the vault and the input is
// cleared on submit; nothing here ever displays a stored token, because the
// API deliberately has no endpoint that returns one.

import { useCallback, useState } from 'react';
import { Card, ConfirmDialog } from '@connorhoehnslalom/ui-components/shared';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';

export interface ConnectionSource { name: string; kind: string }

interface Verified { login: string; name: string | null; scopes: string[] }

interface Props {
  /** All connected sources — this card shows only kind === 'github'. */
  sources: ConnectionSource[];
  /** Called after a connection is created or deleted, to refresh the list. */
  onChanged: () => void;
}

/** Translate an API failure into what the user can act on. */
function describeFailure(status: number, body: { error?: string; problem?: string }): string {
  if (status === 403) {
    return 'You don’t have permission to manage connections — this needs ManageIngest (the hr-admin role).';
  }
  return body.error ?? `HTTP ${status}`;
}

export function ConnectionSetup({ sources, onChanged }: Props) {
  const github = sources.filter((s) => s.kind === 'github');

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<{ name: string; identity: Verified } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const connect = useCallback(async () => {
    if (!label.trim() || !pat.trim()) return;
    setBusy(true);
    setVerified(null);
    const tid = toastPending('Connecting GitHub', label.trim());
    // The token leaves this component exactly once, in the POST body. Clear
    // the field now so it is never re-echoed, even if the request fails.
    const token = pat.trim();
    setPat('');
    try {
      const res = await fetch('/api/connections', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'github', label: label.trim(), apiKey: token }),
      });
      const body = await res.json() as {
        name?: string; verified?: Verified | null; problem?: string; error?: string;
      };
      if (!res.ok) throw new Error(describeFailure(res.status, body));
      // Stored, but the verification call decides whether it actually works.
      // The route's messages are user-worthy; surface them verbatim.
      if (body.problem) {
        toastError(tid, 'Stored, but the token failed verification', body.problem);
      } else if (body.verified) {
        setVerified({ name: body.name ?? '', identity: body.verified });
        toastSuccess(tid, 'Connected', `Connected as ${body.verified.login}${
          body.verified.scopes.length ? ` (${body.verified.scopes.join(', ')})` : ''}`);
      } else {
        toastSuccess(tid, 'Connected', body.name ?? label.trim());
      }
      setLabel(''); setAdding(false);
      onChanged();
    } catch (err) {
      toastError(tid, 'Could not connect', (err as Error).message);
    } finally { setBusy(false); }
  }, [label, pat, onChanged]);

  const remove = useCallback(async (name: string) => {
    const tid = toastPending('Deleting connection', name);
    try {
      const res = await fetch(`/api/connections/${encodeURIComponent(name)}`, {
        method: 'DELETE', credentials: 'include',
      });
      const body = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(describeFailure(res.status, body));
      toastSuccess(tid, 'Deleted', `${name} is gone from the vault.`);
      if (verified?.name === name) setVerified(null);
      onChanged();
    } catch (err) {
      toastError(tid, 'Could not delete', (err as Error).message);
    }
  }, [onChanged, verified]);

  return (
    <Card padding="md" className="mb-4">
      <div className="flex items-center gap-2">
        <div className="text-[13px] font-semibold text-text-primary">GitHub connections</div>
        <div className="flex-1" />
        <button
          onClick={() => { setAdding((v) => !v); setVerified(null); }}
          className="px-2.5 py-1 rounded-md border-none bg-primary text-white text-[11px] font-semibold cursor-pointer"
        >
          {adding ? 'Cancel' : 'Connect GitHub'}
        </button>
      </div>
      <div className="text-[11px] text-text-tertiary mt-1">
        Personal access tokens, held in the credential vault — never stored or shown here.
        Knowledge → Sources manages the same connections; ingest shares this vault.
      </div>

      {adding && (
        <div className="mt-3 pt-3 border-t border-border flex flex-wrap items-end gap-2.5">
          <label>
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
              Label
            </span>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="acme"
              className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary font-mono"
            />
            <span className="block text-[10px] text-text-tertiary mt-1">
              becomes orgiq-github-{label.trim()
                ? label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'default'
                : '<slug>'}
            </span>
          </label>
          <label className="flex-1 min-w-[240px]">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
              Personal access token
            </span>
            <input
              type="password"
              autoComplete="off"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }}
              placeholder="ghp_… or github_pat_…"
              className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary font-mono"
            />
          </label>
          <button
            disabled={busy || !label.trim() || !pat.trim()}
            onClick={() => void connect()}
            className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
          >
            {busy ? 'verifying…' : 'Connect'}
          </button>
        </div>
      )}

      {verified && (
        <div className="mt-2 text-[11px] text-success">
          Connected as {verified.identity.login}
          {verified.identity.scopes.length > 0 && ` (${verified.identity.scopes.join(', ')})`}
        </div>
      )}

      <div className="mt-3">
        {github.length === 0 ? (
          <div className="text-[11px] text-text-tertiary">
            No GitHub connections yet. A token lets discovery browse what it can see, and
            lets private repositories be cloned.
          </div>
        ) : (
          github.map((c) => (
            <div key={c.name} className="flex items-center gap-2 py-1.5 border-t border-border first:border-t-0">
              <span className="text-[12px] font-mono text-text-primary truncate">{c.name}</span>
              <div className="flex-1" />
              <button
                onClick={() => setDeleting(c.name)}
                className="text-[11px] text-text-tertiary hover:text-danger bg-transparent border-none cursor-pointer"
              >
                delete
              </button>
            </div>
          ))
        )}
      </div>

      <ConfirmDialog
        open={!!deleting}
        onConfirm={() => {
          if (deleting) {
            const name = deleting;
            setDeleting(null);
            void remove(name);
          }
        }}
        onCancel={() => setDeleting(null)}
        tone="destructive"
        title={deleting ? `Delete "${deleting}"?` : 'Delete connection?'}
        body="The token is removed from the vault. Repositories linked with it keep working until their next re-clone, which will need another credential."
      />
    </Card>
  );
}
