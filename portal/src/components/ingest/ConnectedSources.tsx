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

import { useCallback, useState } from 'react';
import { Card } from '@connorhoehnslalom/ui-components/shared';
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
  const { data, refresh } = useFetch<{ sources: ConnectedSource[] }>('/api/connections', 60_000);
  const [adding, setAdding] = useState(false);
  const [kind, setKind] = useState<SourceKind>('github');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

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
      <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">CONNECTED SOURCES</span>
        <span className="text-[11px] text-text-tertiary">systems that need a login</span>
        <div className="flex-1" />
        <button
          onClick={() => setAdding((v) => !v)}
          className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] font-semibold text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors"
        >
          {adding ? 'Cancel' : '+ Connect'}
        </button>
      </div>

      {adding && (
        <div className="px-3.5 py-3 border-b border-border">
          <div className="flex flex-wrap items-end gap-2.5">
            <label>
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">System</span>
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as SourceKind)}
                className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
              >
                <option value="github">GitHub</option>
                <option value="confluence">Confluence</option>
                <option value="jira">Jira</option>
              </select>
            </label>
            <label className="flex-1 min-w-[160px]">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">Label</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="acme-corp org"
                className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
              />
            </label>
            <label className="flex-1 min-w-[220px]">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
                {kind === 'github' ? 'Personal access token' : 'API token'}
              </span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={kind === 'github' ? 'ghp_… or github_pat_…' : 'API token'}
                className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary font-mono"
              />
            </label>
            <button
              disabled={busy || !label.trim() || !apiKey.trim()}
              onClick={() => void connect()}
              className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
            >
              {busy ? 'connecting…' : 'Connect'}
            </button>
          </div>
          <div className="text-[11px] text-text-tertiary mt-2 leading-snug">
            The token goes straight into the AgentCore credential vault and is never stored here or shown
            again — not even to you. Rotating it later is a change in the vault, not a redeploy.
            {kind === 'github' && ' A read-only token with repo access is enough.'}
            {kind !== 'github' && ' Stored now; there is no reader for this system yet.'}
          </div>
        </div>
      )}

      {sources.length === 0 ? (
        <div className="px-3.5 py-4 text-[12px] text-text-tertiary leading-snug">
          Nothing connected. Crawl targets reach public pages and uploads need a manual export — this is how
          you reach Confluence, Jira or GitHub.
        </div>
      ) : sources.map((s) => (
        <div key={s.name} className="border-b border-border last:border-b-0">
          <div className="px-3.5 py-2.5 flex items-center gap-3">
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-surface-hover text-text-secondary shrink-0">
              {KIND_LABEL[s.kind]}
            </span>
            <span className="text-[12px] font-mono text-text-primary truncate flex-1">{s.name}</span>
            {!READY_KINDS.has(s.kind) && (
              <span className="text-[11px] text-text-tertiary shrink-0">no reader yet</span>
            )}
            {READY_KINDS.has(s.kind) && (
              <button
                onClick={() => void inspect(s.name)}
                className="px-2 py-1 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors shrink-0"
              >
                {openSource === s.name ? 'Hide' : 'Inspect'}
              </button>
            )}
            <button
              onClick={() => void disconnect(s.name)}
              className="px-2 py-1 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer hover:border-danger hover:text-danger transition-colors shrink-0"
            >
              Remove
            </button>
          </div>

          {openSource === s.name && (
            <div className="px-3.5 pb-3 bg-surface-hover/30">
              {identity && (
                <div className="text-[11px] text-text-secondary mb-2">
                  Authenticated as <span className="font-mono text-text-primary">{identity.login}</span>
                  {identity.name ? ` (${identity.name})` : ''}
                  {identity.scopes.length > 0
                    ? ` · scopes: ${identity.scopes.join(', ')}`
                    : ' · fine-grained token (scopes not advertised)'}
                </div>
              )}
              {loading === 'identity' && <div className="text-[11px] text-text-tertiary">checking the credential…</div>}
              {loading === 'repos' && <div className="text-[11px] text-text-tertiary">reading repositories…</div>}

              {repos && repos.length === 0 && (
                <div className="text-[11px] text-text-tertiary">
                  This token can see no repositories — it may lack repo scope.
                </div>
              )}

              {repos && repos.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {repos.slice(0, 24).map((r) => (
                    <button
                      key={r.fullName}
                      onClick={() => void preview(s.name, r.fullName)}
                      className={`px-2 py-0.5 rounded-full border text-[11px] font-mono cursor-pointer transition-colors ${
                        signals?.repo === r.fullName
                          ? 'border-primary text-primary bg-primary/5'
                          : 'border-border text-text-secondary hover:border-primary/50'}`}
                    >
                      {r.fullName}
                    </button>
                  ))}
                </div>
              )}

              {loading?.startsWith('signal:') && (
                <div className="text-[11px] text-text-tertiary">reading commit history…</div>
              )}

              {signals && (
                signals.rows.length === 0 ? (
                  <div className="text-[11px] text-text-tertiary">
                    No attributable commits in the last 180 days. Commits with no linked GitHub account are
                    skipped rather than guessed at from the email address.
                  </div>
                ) : (
                  <div className="rounded-md border border-border overflow-hidden bg-surface">
                    <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary border-b border-border">
                      Contribution signal · {signals.repo} · last 180 days
                    </div>
                    {signals.rows.slice(0, 10).map((row) => (
                      <div key={row.login} className="px-2.5 py-1.5 border-b border-border last:border-b-0 flex items-center gap-2.5">
                        <span className="text-[11px] font-mono text-text-primary w-36 truncate">{row.login}</span>
                        <span className="text-[11px] text-text-secondary tabular-nums w-16">{row.commits} commits</span>
                        <span className="text-[11px] text-text-tertiary truncate flex-1">
                          {Object.keys(row.languages).slice(0, 4).join(', ') || '—'}
                          {row.areas.length > 0 ? ` · ${row.areas.slice(0, 3).join(', ')}` : ''}
                        </span>
                      </div>
                    ))}
                    <div className="px-2.5 py-2 text-[11px] text-text-tertiary leading-snug border-t border-border">
                      Preview only — nothing here has been written to the graph. This is what real expertise
                      evidence would look like against the scores, which are currently generated.
                    </div>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      ))}
    </Card>
  );
}
