// Projects — repositories that bots work on.
//
// Deliberately not a GitHub view. Everything familiar there exists to
// coordinate people: issue lists, review threads, comment history, who
// reacted. On a repository whose contributors are agents there is nobody to
// coordinate with, so those surfaces would be empty at best and misleading at
// worst — they would imply a conversation that is not happening.
//
// What replaces them is the run: what was asked, which model answered, how
// long it took, and whether the working tree ended up different. That is the
// unit of activity here, and the list is ordered by it.
//
// The workspace is the other half. A project is durable; the microVM holding
// its checkout is not — it can be wiped by an image push or expire after two
// weeks idle — so the page treats "cloned into a workspace" as a state that
// can lapse and be re-established, never as a property of the project.

import { useCallback, useEffect, useState } from 'react';
import { PageSection, Card } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';
import { loadBoxes, createBox, type DevboxBox } from '../../lib/devboxRegistry';
import { openShell } from '../../lib/terminalDock';

interface Run {
  id: string; prompt: string; model: string | null;
  status: 'running' | 'done' | 'failed';
  startedAt: string; durationMs: number | null;
  filesChanged: number | null; diffSummary: string | null; error: string | null;
}
interface Project {
  id: string; repoFullName: string; defaultBranch: string;
  connectionName: string | null; sessionId: string | null;
  checkout: string; clonedAt: string | null; runs: Run[];
  orgProjectId: string | null; orgProjectName: string | null;
  owners: Array<{ personId: string; name: string; role: string | null }>;
}
interface OrgProject { id: string; name: string; status: string | null }
interface ConnectedSource { name: string; kind: string }
interface RepoRef { fullName: string }

const STATUS_TONE: Record<Run['status'], string> = {
  running: 'bg-warning-bg text-warning',
  done: 'bg-success-bg text-success',
  failed: 'bg-danger-bg text-danger',
};

function when(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (Number.isNaN(mins)) return '—';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

function dur(ms: number | null): string {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`;
}

export default function AgentProjectsPage() {
  const { data, refresh } = useFetch<{ projects: Project[] }>('/api/agent-projects', 15_000);
  const { data: connections } = useFetch<{ sources: ConnectedSource[] }>('/api/connections', 60_000);
  // The initiatives a repository can be attached to. An enterprise has both:
  // people who own the work and code that delivers it.
  const { data: orgProjects } = useFetch<OrgProject[]>('/api/graph/projects', 120_000);

  const [boxes, setBoxes] = useState<DevboxBox[]>([]);
  useEffect(() => { try { setBoxes(loadBoxes()); } catch { setBoxes([]); } }, [data]);

  const [linking, setLinking] = useState(false);
  const [repo, setRepo] = useState('');
  const [connection, setConnection] = useState('');
  const [orgProject, setOrgProject] = useState('');
  const [repoOptions, setRepoOptions] = useState<RepoRef[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // The run box: one prompt, one project, fired into a workspace.
  const [runFor, setRunFor] = useState<Project | null>(null);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState('claude-haiku-4-5');

  const githubConnections = (connections?.sources ?? []).filter((c) => c.kind === 'github');

  // Offer the repositories a connection can already see, so linking is a pick
  // rather than a typing exercise that fails on a typo an hour later.
  useEffect(() => {
    if (!connection) { setRepoOptions([]); return; }
    let cancelled = false;
    void (async () => {
      try {
        const r = await (await fetch(
          `/api/connections/${encodeURIComponent(connection)}/github/repos?limit=50`,
          { credentials: 'include' },
        )).json() as { repos?: RepoRef[] };
        if (!cancelled) setRepoOptions(r.repos ?? []);
      } catch { if (!cancelled) setRepoOptions([]); }
    })();
    return () => { cancelled = true; };
  }, [connection]);

  const link = useCallback(async () => {
    if (!repo.trim()) return;
    setBusy('link');
    const tid = toastPending('Linking project', repo);
    try {
      const res = await fetch('/api/agent-projects', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoFullName: repo.trim(),
          connectionName: connection || null,
          orgProjectId: orgProject || null,
        }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Linked', `${repo} is now a project.`);
      setRepo(''); setLinking(false); refresh();
    } catch (err) {
      toastError(tid, 'Could not link', (err as Error).message);
    } finally { setBusy(null); }
  }, [repo, connection, orgProject, refresh]);

  const unlink = useCallback(async (p: Project) => {
    const tid = toastPending('Unlinking', p.repoFullName);
    try {
      const res = await fetch(`/api/agent-projects/${p.id}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, 'Unlinked', 'The checkout in the workspace is left alone.');
      refresh();
    } catch (err) {
      toastError(tid, 'Could not unlink', (err as Error).message);
    }
  }, [refresh]);

  /** Clone into a workspace, creating one if there is none yet. */
  const clone = useCallback(async (p: Project) => {
    setBusy(`clone:${p.id}`);
    const tid = toastPending('Cloning into a workspace', p.repoFullName);
    try {
      let box = boxes.find((b) => b.sessionId === p.sessionId) ?? boxes[boxes.length - 1];
      if (!box) box = await createBox();

      const res = await fetch(`/api/agent-projects/${p.id}/clone-command`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: box.sessionId }),
      });
      const body = await res.json() as { command?: string; cwd?: string; error?: string };
      if (!res.ok || !body.command) throw new Error(body.error ?? `HTTP ${res.status}`);

      // Run it in the devbox. `full` mode because a clone writes, and the
      // command carries a credential for private repos — so it is sent, never
      // displayed or stored client-side.
      const run = await fetch(`/api/devbox/${encodeURIComponent(box.sessionId)}/command`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: body.command, mode: 'full', cwd: body.cwd ?? '/mnt/workspace' }),
      });
      if (!run.ok) throw new Error(`clone failed: HTTP ${run.status}`);
      // The command endpoint streams; draining it is what waits for completion.
      await run.text();

      toastSuccess(tid, 'Cloned', `${p.repoFullName} is in ${box.label}.`);
      setBoxes(loadBoxes());
      refresh();
    } catch (err) {
      toastError(tid, 'Could not clone', (err as Error).message);
    } finally { setBusy(null); }
  }, [boxes, refresh]);

  /** Send a task to Claude Code inside the project's workspace. */
  const run = useCallback(async () => {
    const p = runFor;
    if (!p || !prompt.trim()) return;
    setBusy('run');
    const tid = toastPending('Starting run', p.repoFullName);
    try {
      const box = boxes.find((b) => b.sessionId === p.sessionId);
      if (!box) throw new Error('This project has no workspace yet — clone it first.');

      // The server owns the run from here: it invokes the task, waits for it,
      // then measures the repository. Previously this tab drove the task, so
      // closing it left the run recorded as `running` forever.
      const started = await fetch(`/api/agent-projects/${p.id}/runs`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), model, sessionId: box.sessionId }),
      });
      const rec = await started.json() as { run?: { id: string }; checkout?: string; error?: string };
      if (!started.ok || !rec.run) throw new Error(rec.error ?? `HTTP ${started.status}`);

      toastSuccess(tid, 'Running', 'It will finish on its own — you can close this.');
      openShell({ id: box.id, label: box.label, sessionId: box.sessionId });
      setRunFor(null); setPrompt('');
      refresh();
    } catch (err) {
      toastError(tid, 'Could not start', (err as Error).message);
    } finally { setBusy(null); }
  }, [runFor, prompt, model, boxes, refresh]);

  const projects = data?.projects ?? [];

  return (
    <PageSection
      title="Codebases"
      description="Repositories that agents work on, and the initiatives they deliver. What matters here is what the bots did — not the human collaboration furniture."
    >
      <div className="flex items-center gap-2 mb-4">
        <button
          onClick={() => setLinking((v) => !v)}
          className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer"
        >
          {linking ? 'Cancel' : '+ Link a repository'}
        </button>
        {githubConnections.length === 0 && (
          <span className="text-[11px] text-text-tertiary">
            No GitHub connection yet — add one in Knowledge → Sources to link private repositories.
          </span>
        )}
      </div>

      {linking && (
        <Card padding="md" className="mb-4">
          <div className="flex flex-wrap items-end gap-2.5">
            <label>
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
                Credential
              </span>
              <select
                value={connection}
                onChange={(e) => setConnection(e.target.value)}
                className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
              >
                <option value="">none (public repo)</option>
                {githubConnections.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
              </select>
            </label>
            <label className="flex-1 min-w-[240px]">
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
                Repository
              </span>
              <input
                list="repo-options"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void link(); }}
                placeholder="owner/name"
                className="w-full px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary font-mono"
              />
              <datalist id="repo-options">
                {repoOptions.map((r) => <option key={r.fullName} value={r.fullName} />)}
              </datalist>
            </label>
            <label>
              <span className="block text-[10px] font-semibold uppercase tracking-wide text-text-tertiary mb-1">
                Initiative
              </span>
              <select
                value={orgProject}
                onChange={(e) => setOrgProject(e.target.value)}
                className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
              >
                <option value="">unattached</option>
                {(orgProjects ?? []).map((op) => (
                  <option key={op.id} value={op.id}>{op.name}</option>
                ))}
              </select>
            </label>
            <button
              disabled={busy === 'link' || !repo.trim()}
              onClick={() => void link()}
              className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
            >
              {busy === 'link' ? 'linking…' : 'Link'}
            </button>
          </div>
          {connection && repoOptions.length > 0 && (
            <div className="text-[11px] text-text-tertiary mt-2">
              {repoOptions.length} repositories visible to this credential.
            </div>
          )}
        </Card>
      )}

      {projects.length === 0 ? (
        <Card padding="md">
          <div className="text-[13px] font-semibold text-text-primary">No projects linked</div>
          <div className="text-[12px] text-text-secondary mt-1 leading-snug">
            Link a repository to clone it into a workspace and run agents against it. Public repositories
            need no credential.
          </div>
        </Card>
      ) : (
        <div className="grid gap-4 grid-cols-1 xl:grid-cols-2">
          {projects.map((p) => {
            const box = boxes.find((b) => b.sessionId === p.sessionId);
            const inWorkspace = Boolean(p.clonedAt && box);
            return (
              <Card key={p.id} padding="none" className="overflow-hidden">
                <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
                  <span className="text-[13px] font-semibold font-mono text-text-primary truncate">
                    {p.repoFullName}
                  </span>
                  {!p.connectionName && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-hover text-text-tertiary shrink-0">
                      public
                    </span>
                  )}
                  {p.orgProjectName && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0 truncate max-w-[40%]"
                          title={`Delivers: ${p.orgProjectName}`}>
                      {p.orgProjectName}
                    </span>
                  )}
                  <div className="flex-1" />
                  <button
                    onClick={() => void unlink(p)}
                    className="text-[11px] text-text-tertiary hover:text-danger bg-transparent border-none cursor-pointer"
                  >
                    unlink
                  </button>
                </div>

                <div className="px-3.5 py-2.5 flex items-center gap-2 flex-wrap border-b border-border">
                  {inWorkspace ? (
                    <>
                      <span className="text-[11px] text-success">in {box?.label}</span>
                      <span className="text-[11px] text-text-tertiary font-mono truncate">{p.checkout}</span>
                      <div className="flex-1" />
                      <button
                        onClick={() => { setRunFor(p); setPrompt(''); }}
                        className="px-2.5 py-1 rounded-md border-none bg-primary text-white text-[11px] font-semibold cursor-pointer"
                      >
                        Run a task
                      </button>
                      <button
                        onClick={() => box && openShell({ id: box.id, label: box.label, sessionId: box.sessionId })}
                        className="px-2.5 py-1 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors"
                      >
                        Open shell
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="text-[11px] text-text-tertiary">
                        {p.clonedAt
                          // A workspace is disposable; the project is not.
                          ? 'Its workspace is gone — microVMs are wiped by image pushes and expire when idle.'
                          : 'Not in a workspace yet.'}
                      </span>
                      <div className="flex-1" />
                      <button
                        disabled={busy === `clone:${p.id}`}
                        onClick={() => void clone(p)}
                        className="px-2.5 py-1 rounded-md border-none bg-primary text-white text-[11px] font-semibold cursor-pointer disabled:opacity-50"
                      >
                        {busy === `clone:${p.id}` ? 'cloning…' : p.clonedAt ? 'Re-clone' : 'Clone into workspace'}
                      </button>
                    </>
                  )}
                </div>

                {p.owners.length > 0 && (
                  <div className="px-3.5 py-2 border-b border-border text-[11px] text-text-tertiary">
                    Accountable: {p.owners.map((o) => o.name + (o.role ? ` (${o.role})` : '')).join(', ')}
                  </div>
                )}

                {p.runs.length === 0 ? (
                  <div className="px-3.5 py-3 text-[11px] text-text-tertiary">
                    Nothing has been run against this yet.
                  </div>
                ) : (
                  p.runs.map((r) => (
                    <div key={r.id} className="px-3.5 py-2 border-b border-border last:border-b-0 flex items-start gap-2.5">
                      <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${STATUS_TONE[r.status]}`}>
                        {r.status}
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] text-text-primary truncate" title={r.prompt}>{r.prompt}</div>
                        <div className="text-[11px] text-text-tertiary">
                          {when(r.startedAt)}
                          {r.model ? ` · ${r.model}` : ''}
                          {r.durationMs != null ? ` · ${dur(r.durationMs)}` : ''}
                          {r.filesChanged != null ? ` · ${r.filesChanged} files changed` : ''}
                        </div>
                        {r.diffSummary && (
                          <div className="text-[11px] text-text-secondary mt-0.5 truncate" title={r.diffSummary}>
                            {r.diffSummary}
                          </div>
                        )}
                        {r.error && <div className="text-[11px] text-danger mt-0.5 truncate">{r.error}</div>}
                      </div>
                    </div>
                  ))
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* The run box. One prompt, one project — the thing you reach for. */}
      {runFor && (
        <div
          className="fixed inset-0 z-[150] bg-black/40 flex items-start justify-center pt-[18vh]"
          onClick={() => setRunFor(null)}
        >
          <div
            className="w-[560px] max-w-[92vw] rounded-lg border border-border bg-surface shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-4 py-2.5 border-b border-border flex items-center gap-2">
              <span className="text-xs font-semibold text-text-secondary">RUN ON</span>
              <span className="text-[12px] font-mono text-text-primary">{runFor.repoFullName}</span>
            </div>
            <div className="p-4">
              <textarea
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
                  if (e.key === 'Escape') setRunFor(null);
                }}
                rows={4}
                placeholder="Add a health check endpoint and a test for it. Commit on a branch."
                className="w-full px-2.5 py-2 rounded-md border border-border bg-surface text-[12px] text-text-primary resize-y"
              />
              <div className="flex items-center gap-2 mt-2.5">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="px-2 py-1.5 rounded-md border border-border bg-surface text-[12px] text-text-primary"
                >
                  <option value="claude-haiku-4-5">Haiku</option>
                  <option value="claude-sonnet-5">Sonnet</option>
                  <option value="claude-opus-5">Opus</option>
                </select>
                <span className="text-[11px] text-text-tertiary flex-1">⌘⏎ to run · esc to close</span>
                <button
                  disabled={busy === 'run' || !prompt.trim()}
                  onClick={() => void run()}
                  className="px-3 py-1.5 rounded-md border-none bg-primary text-white text-[12px] font-semibold cursor-pointer disabled:opacity-40"
                >
                  {busy === 'run' ? 'starting…' : 'Run'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </PageSection>
  );
}
