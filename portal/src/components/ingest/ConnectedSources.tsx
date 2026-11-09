// Connected sources — the systems an org's knowledge actually lives in.
//
// Crawl targets reach public URLs. Uploads need someone to export files by
// hand. Neither reaches Confluence, Jira or GitHub, which is where the real
// material is, so this is the third way in.
//
// The token is handed to AgentCore Identity and never comes back. There is no
// endpoint that returns a stored credential, so this panel can show that a
// connection exists and whether it still works, but it can never show the
// secret — including to the person who typed it in.
//
// GitHub is the one with a reader so far, and it is deliberately preview-only:
// contribution signal is displayed, not written to the graph. These numbers
// would move expertise scores, and scores that move for reasons nobody
// inspected are how a system stops being trusted.

import { plural } from '../../lib/plural';
import { useCallback, useState } from 'react';
import {
  Button, Card, Chip, ConfirmDialog, EmptyState, EntityCell, FilterChip, FormField, Inline, Input,
  MetaLine, SectionLabel, Select, Stack, Toolbar,
} from '@connorhoehn/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';

type SourceKind = 'github' | 'confluence' | 'jira' | 'unknown';

interface ConnectedSource {
  name: string; kind: SourceKind; authType: 'api-key' | 'oauth2'; createdAt: string | null;
}
interface Identity { login: string; name: string | null; scopes: string[] }
interface RepoRef { owner: string; name: string; fullName: string }
interface Signal {
  login: string; repo: string; commits: number; areas: string[];
  languages: Record<string, number>; lastActivityAt: string | null;
}

const KIND_LABEL: Record<SourceKind, string> = {
  github: 'GitHub', confluence: 'Confluence', jira: 'Jira', unknown: 'Unknown',
};

/** Only GitHub has a reader today; the others store a credential and wait. */
const READY_KINDS = new Set<SourceKind>(['github']);

export function ConnectedSources() {
  // Connect/remove ride /api/connections (ManageIngest).
  const { can, ready } = useCapabilities();
  const canManage = ready && can('ManageIngest');
  const { data, refresh } = useFetch<{ sources: ConnectedSource[] }>('/api/connections', 60_000);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<SourceKind>('github');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  const [removeTarget, setRemoveTarget] = useState<ConnectedSource | null>(null);
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [repos, setRepos] = useState<RepoRef[] | null>(null);
  const [signals, setSignals] = useState<{ repo: string; rows: Signal[] } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  const connect = useCallback(async () => {
    if (!label.trim() || !apiKey.trim()) return;
    setBusy(true);
    const tid = toastPending('Storing the credential', KIND_LABEL[kind]);
    try {
      const res = await fetch('/api/connections', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, label: label.trim(), apiKey: apiKey.trim() }),
      });
      const body = await res.json() as { name?: string; verified?: Identity; problem?: string; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);

      // The credential is stored either way — say so plainly when it stored
      // but does not work, rather than reporting a flat success.
      if (body.problem) {
        toastError(tid, 'Stored, but it does not work', body.problem);
      } else {
        toastSuccess(tid, 'Connected',
          body.verified ? `Authenticated as ${body.verified.login}.` : 'Credential stored.');
      }
      setApiKey('');
      setLabel('');
      setAdding(false);
      refresh();
    } catch (err) {
      toastError(tid, 'Could not connect', (err as Error).message);
    } finally { setBusy(false); }
  }, [kind, label, apiKey, refresh]);

  const disconnect = useCallback(async (name: string) => {
    const tid = toastPending('Removing', name);
    try {
      const res = await fetch(`/api/connections/${encodeURIComponent(name)}`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, 'Disconnected', 'The credential has been deleted from the vault.');
      if (openSource === name) { setOpenSource(null); setRepos(null); setSignals(null); }
      refresh();
    } catch (err) {
      toastError(tid, 'Could not remove', (err as Error).message);
    }
  }, [refresh, openSource]);

  const inspect = useCallback(async (name: string) => {
    if (openSource === name) { setOpenSource(null); return; }
    setOpenSource(name);
    setRepos(null); setSignals(null); setIdentity(null);
    setLoading('identity');
    try {
      const chk = await (await fetch(`/api/connections/${encodeURIComponent(name)}/check`, { credentials: 'include' })).json() as
        { ok: boolean; identity?: Identity; error?: string };
      if (!chk.ok) throw new Error(chk.error ?? 'check failed');
      setIdentity(chk.identity ?? null);

      setLoading('repos');
      const r = await (await fetch(`/api/connections/${encodeURIComponent(name)}/github/repos?limit=30`, { credentials: 'include' })).json() as
        { repos?: RepoRef[]; error?: string };
      setRepos(r.repos ?? []);
    } catch (err) {
      toastError(null, 'Could not read this connection', (err as Error).message);
      setOpenSource(null);
    } finally { setLoading(null); }
  }, [openSource]);

  const preview = useCallback(async (name: string, repo: string) => {
    setLoading(`signal:${repo}`);
    setSignals(null);
    try {
      const res = await fetch(
        `/api/connections/${encodeURIComponent(name)}/github/signal?repo=${encodeURIComponent(repo)}&sinceDays=180`,
        { credentials: 'include' },
      );
      const body = await res.json() as { signals?: Signal[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setSignals({ repo, rows: body.signals ?? [] });
    } catch (err) {
      toastError(null, 'Could not read contributions', (err as Error).message);
    } finally { setLoading(null); }
  }, []);

  const sources = data?.sources ?? [];

  return (
    <Card padding="none" className="overflow-hidden mb-4">
      <Toolbar
        bordered
        size="sm"
        end={canManage ? (
          <Button variant="secondary" size="sm" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : '+ Connect'}
          </Button>
        ) : undefined}
      >
        <SectionLabel>Connected sources</SectionLabel>
        <MetaLine size="xs" items={['systems that need a login']} />
      </Toolbar>

      {adding && (
        <Stack gap="sm" className="px-3.5 py-3 border-b border-border">
          {/* `labelId` is dropped from every wiring bag: FormField hands it to
              the consumer but it is not a DOM prop, so spreading it onto a
              control makes React warn. Queued against the library. */}
          <Inline gap="sm" align="end" wrap>
            <FormField label="System">
              {({ labelId: _l, ...w }) => (
                <Select
                  {...w}
                  size="sm"
                  value={kind}
                  onChange={(e) => setKind(e.target.value as SourceKind)}
                  options={[
                    { value: 'github', label: 'GitHub' },
                    { value: 'confluence', label: 'Confluence' },
                    { value: 'jira', label: 'Jira' },
                  ]}
                />
              )}
            </FormField>

            <FormField label="Label" className="flex-1 min-w-[160px]">
              {({ labelId: _l, ...w }) => (
                <Input
                  {...w}
                  size="sm"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="acme-corp org"
                />
              )}
            </FormField>

            <FormField
              label={kind === 'github' ? 'Personal access token' : 'API token'}
              className="flex-1 min-w-[220px]"
            >
              {({ labelId: _l, ...w }) => (
                <Input
                  {...w}
                  type="password"
                  size="sm"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={kind === 'github' ? 'ghp_… or github_pat_…' : 'API token'}
                />
              )}
            </FormField>

            <Button
              variant="primary"
              size="sm"
              disabled={busy || !label.trim() || !apiKey.trim()}
              onClick={() => void connect()}
            >
              {busy ? 'connecting…' : 'Connect'}
            </Button>
          </Inline>

          <MetaLine
            size="xs"
            items={[
              'The token goes straight into the AgentCore credential vault and is never stored here or '
              + 'shown again — not even to you. Rotating it later is a change in the vault, not a redeploy.'
              + (kind === 'github'
                ? ' A read-only token with repo access is enough.'
                : ' Stored now; there is no reader for this system yet.'),
            ]}
          />
        </Stack>
      )}

      {sources.length === 0 ? (
        <EmptyState
          title="Nothing connected"
          body={'Crawl targets reach public pages and uploads need a manual export — this is how you '
            + 'reach Confluence, Jira or GitHub.'}
        />
      ) : sources.map((s) => (
        <Stack key={s.name} gap="none" className="border-b border-border last:border-b-0">
          <Inline gap="sm" className="px-3.5 py-2.5">
            <Chip tone="neutral" size="xs" className="shrink-0">{KIND_LABEL[s.kind]}</Chip>
            <EntityCell mono label={s.name} className="flex-1 min-w-0" />
            {!READY_KINDS.has(s.kind) && (
              <MetaLine size="xs" items={['no reader yet']} className="shrink-0" />
            )}
            {READY_KINDS.has(s.kind) && (
              <Button variant="secondary" size="sm" onClick={() => void inspect(s.name)}>
                {openSource === s.name ? 'Hide' : 'Inspect'}
              </Button>
            )}
            {canManage && (
              <Button variant="danger" size="sm" onClick={() => setRemoveTarget(s)}>
                Remove
              </Button>
            )}
          </Inline>

          {openSource === s.name && (
            <Stack gap="sm" className="px-3.5 pb-3 bg-surface-hover/30">
              {identity && (
                <MetaLine
                  size="xs"
                  tone="secondary"
                  items={[
                    <>Authenticated as <Chip tone="neutral" size="xs" mono>{identity.login}</Chip>{identity.name ? ` (${identity.name})` : ''}</>,
                    identity.scopes.length > 0
                      ? `scopes: ${identity.scopes.join(', ')}`
                      : 'fine-grained token (scopes not advertised)',
                  ]}
                />
              )}
              {loading === 'identity' && <MetaLine size="xs" items={['checking the credential…']} />}
              {loading === 'repos' && <MetaLine size="xs" items={['reading repositories…']} />}

              {repos && repos.length === 0 && (
                <MetaLine size="xs" items={['This token can see no repositories — it may lack repo scope.']} />
              )}

              {repos && repos.length > 0 && (
                <Inline gap="xs" wrap>
                  {repos.slice(0, 24).map((r) => (
                    // FilterChip, not Button: this is a one-of-many selection,
                    // and at 24 repos the button's padding cost two extra rows.
                    <FilterChip
                      key={r.fullName}
                      active={signals?.repo === r.fullName}
                      size="xs"
                      onClick={() => void preview(s.name, r.fullName)}
                    >
                      {r.fullName}
                    </FilterChip>
                  ))}
                </Inline>
              )}

              {loading?.startsWith('signal:') && (
                <MetaLine size="xs" items={['reading commit history…']} />
              )}

              {signals && (
                signals.rows.length === 0 ? (
                  <MetaLine
                    size="xs"
                    items={['No attributable commits in the last 180 days. Commits with no linked GitHub '
                      + 'account are skipped rather than guessed at from the email address.']}
                  />
                ) : (
                  <Card padding="none" className="overflow-hidden">
                    <Toolbar bordered size="sm">
                      <SectionLabel>
                        {`Contribution signal · ${signals.repo} · last 180 days`}
                      </SectionLabel>
                    </Toolbar>
                    {signals.rows.slice(0, 10).map((row) => (
                      <Inline key={row.login} gap="sm" className="px-2.5 py-1.5 border-b border-border last:border-b-0">
                        <EntityCell mono label={row.login} className="w-36 shrink-0" />
                        <MetaLine size="xs" tone="secondary" className="w-16 shrink-0 tabular-nums" items={[plural(row.commits, 'commit')]} />
                        <MetaLine
                          size="xs"
                          className="flex-1 min-w-0"
                          items={[
                            Object.keys(row.languages).slice(0, 4).join(', ') || '—',
                            ...(row.areas.length > 0 ? [row.areas.slice(0, 3).join(', ')] : []),
                          ]}
                        />
                      </Inline>
                    ))}
                    <MetaLine
                      size="xs"
                      className="px-2.5 py-2 border-t border-border"
                      items={['Preview only — nothing here has been written to the graph. This is what real '
                        + 'expertise evidence would look like against the scores, which are currently generated.']}
                    />
                  </Card>
                )
              )}
            </Stack>
          )}
        </Stack>
      ))}

      <ConfirmDialog
        open={!!removeTarget}
        onConfirm={() => {
          if (removeTarget) {
            const name = removeTarget.name;
            setRemoveTarget(null);
            void disconnect(name);
          }
        }}
        onCancel={() => setRemoveTarget(null)}
        tone="destructive"
        title={removeTarget ? `Remove "${removeTarget.name}"?` : 'Remove connection?'}
        body="Deletes the stored credential from the vault. You'll need to re-enter it to reconnect — the token is never shown back to you."
      />
    </Card>
  );
}
