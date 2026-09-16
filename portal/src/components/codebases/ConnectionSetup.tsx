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
import {
  Button, Card, CardHeader, Chip, ConfirmDialog, FormField, InlineAlert, Inline, Input,
  MetaLine, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
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
  // Create/delete ride /api/connections (ManageIngest) — the list stays
  // readable, the mutating affordances hide without the capability.
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageIngest');

  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [pat, setPat] = useState('');
  const [busy, setBusy] = useState(false);
  const [verified, setVerified] = useState<{ name: string; identity: Verified } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

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
    setRemoving(name);
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
    } finally {
      setRemoving(null);
      setDeleting(null);
    }
  }, [onChanged, verified]);

  const slug = label.trim()
    ? label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'default'
    : '<slug>';

  return (
    <Card padding="md" className="mb-4">
      <CardHeader
        title="GitHub connections"
        subtitle="Personal access tokens, held in the credential vault — never stored or shown here. Knowledge → Sources manages the same connections; ingest shares this vault."
        action={canManage ? (
          <Button
            variant="primary"
            size="sm"
            onClick={() => { setAdding((v) => !v); setVerified(null); }}
          >
            {adding ? 'Cancel' : 'Connect GitHub'}
          </Button>
        ) : undefined}
      />

      {adding && (
        <Inline gap="md" align="end" wrap className="mt-3 pt-3 border-t border-border">
          {/* `labelId` is pulled out of the wiring bag deliberately: FormField
              hands it to the consumer but it is not a DOM prop, and spreading
              it onto Input reaches the element and makes React warn on every
              render. Queued against the library in ui-components-queue.md. */}
          <FormField label="Label" hint={`becomes orgiq-github-${slug}`}>
            {({ labelId: _labelId, ...wiring }) => (
              <Input
                {...wiring}
                mono
                size="sm"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="acme"
              />
            )}
          </FormField>
          <FormField label="Personal access token" className="flex-1 min-w-[240px]">
            {({ labelId: _labelId, ...wiring }) => (
              <Input
                {...wiring}
                mono
                size="sm"
                type="password"
                autoComplete="off"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void connect(); }}
                placeholder="ghp_… or github_pat_…"
              />
            )}
          </FormField>
          <Button
            variant="primary"
            size="sm"
            disabled={busy || !label.trim() || !pat.trim()}
            onClick={() => void connect()}
          >
            {busy ? 'verifying…' : 'Connect'}
          </Button>
        </Inline>
      )}

      {verified && (
        <InlineAlert tone="success" className="mt-2">
          Connected as {verified.identity.login}
          {verified.identity.scopes.length > 0 && ` (${verified.identity.scopes.join(', ')})`}
        </InlineAlert>
      )}

      <Stack gap="none" className="mt-3">
        {github.length === 0 ? (
          <MetaLine
            size="xs"
            items={['No GitHub connections yet. A token lets discovery browse what it can see, and lets private repositories be cloned.']}
          />
        ) : (
          github.map((c) => (
            <Inline
              key={c.name}
              gap="sm"
              align="center"
              justify="between"
              className="py-1.5 border-t border-border first:border-t-0"
            >
              <Chip size="xs" mono>{c.name}</Chip>
              {canManage && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={removing === c.name}
                  onClick={() => setDeleting(c.name)}
                >
                  delete
                </Button>
              )}
            </Inline>
          ))
        )}
      </Stack>

      <ConfirmDialog
        open={!!deleting}
        onConfirm={() => { if (deleting) void remove(deleting); }}
        onCancel={() => setDeleting(null)}
        tone="destructive"
        title={deleting ? `Delete "${deleting}"?` : 'Delete connection?'}
        body="This credential is shared with Knowledge → Sources, which manages the same connections. Deleting it here removes it from the vault everywhere. Repositories linked with it keep working until their next re-clone, which will need another credential."
        confirmLabel={deleting && removing === deleting ? 'Deleting…' : 'Delete connection'}
        confirmDisabled={!!deleting && removing === deleting}
      />
    </Card>
  );
}
