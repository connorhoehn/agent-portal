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
import { Link, useSearchParams } from 'react-router';
import {
  Button,
  Card,
  CatalogGrid,
  Chip,
  EmptyState,
  Inline,
  Input,
  Link as ExternalLink,
  MetaLine,
  Modal,
  PageSection,
  SectionLabel,
  Select,
  Stack,
  Textarea,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { redactUrlCredentials } from '../../lib/redactCredentials.ts';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';
import { openShell, useCompute, type Computer } from '@connorhoehnslalom/ui-components/compute';
import { DEVBOX_MODELS, DEFAULT_DEVBOX_MODEL } from '../../lib/devboxModels';
import { durationLabel, relativeTime } from '../../lib/relativeTime';
import { ConnectionSetup } from '../../components/codebases/ConnectionSetup';
import { RepoDiscovery } from '../../components/codebases/RepoDiscovery';


interface Run {
  id: string; prompt: string; model: string | null;
  status: 'running' | 'done' | 'failed';
  startedAt: string; durationMs: number | null;
  filesChanged: number | null; diffSummary: string | null; error: string | null;
  costUsd?: number | null;
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

const STATUS_TONE: Record<Run['status'], 'warning' | 'success' | 'danger'> = {
  running: 'warning', done: 'success', failed: 'danger',
};

// Accept a pasted GitHub URL (HTTPS or SSH) or a bare owner/name and reduce it
// to "owner/repo". Handles: https://github.com/o/r(.git)(/tree/main…),
// git@github.com:o/r.git, ssh://git@github.com/o/r, github.com/o/r, o/r.
export function parseRepoInput(raw: string): string | null {
  let s = (raw ?? '').trim();
  if (!s) return null;
  s = s.replace(/^git@[^:]+:/i, '');            // scp-style SSH → path
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // scheme://
  s = s.replace(/^[^@/]+@/, '');                 // user@ (ssh:// form)
  const parts = s.split('/').filter(Boolean);
  let owner: string | undefined;
  let repo: string | undefined;
  if (parts[0]?.includes('.')) {                 // leading segment is a host
    if (parts.length < 3) return null;
    [, owner, repo] = parts;
  } else if (parts.length >= 2) {
    [owner, repo] = parts;
  } else {
    return null;
  }
  repo = (repo ?? '').split(/[?#]/)[0]!.replace(/\.git$/i, '');
  if (!owner || !repo) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo)) return null;
  return `${owner}/${repo}`;
}

export default function AgentProjectsPage() {
  const { data, refresh } = useFetch<{ projects: Project[] }>('/api/agent-projects', 15_000);
  // link/unlink/clone/run-task ride /api/agent-projects + /api/devbox
  // (ManageDevbox); connection add/delete rides /api/connections (ManageIngest).
  const { can, ready } = useCapabilities();
  const canDevbox = ready && can('ManageDevbox');
  const canIngest = ready && can('ManageIngest');

  // Deep links from the rest of the SDLC loop: /admin/projects?project=<id>
  // scrolls to that codebase, &run=<id> highlights the run that a change was
  // captured from — so "run 1a2b3c4d" on a change card lands on the evidence.
  const [searchParams] = useSearchParams();
  const focusProject = searchParams.get('project');
  const focusRun = searchParams.get('run');
  // The list API carries only each project's 5 newest runs; a linked run may
  // be older, so the focused project gets its full run history.
  const { data: focusRuns } = useFetch<{ runs: Run[] }>(
    focusProject ? `/api/agent-projects/${focusProject}/runs` : null, 30_000);
  useEffect(() => {
    if (!focusProject || !data) return;
    document.getElementById(`project-${focusProject}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [focusProject, data]);
  const { data: connections, refresh: refreshConnections } =
    useFetch<{ sources: ConnectedSource[] }>('/api/connections', 60_000);
  // The initiatives a repository can be attached to. An enterprise has both:
  // people who own the work and code that delivers it.
  const { data: orgProjects } = useFetch<OrgProject[]>('/api/graph/projects', 120_000);
  // Open change requests, so a codebase shows what governance is holding — the
  // SDLC loop is only legible if it is visible from where the runs start.
  const { data: changesData } = useFetch<{ changes: Array<{ projectId: string; status: string }> }>(
    '/api/sdlc/changes?open=true', 15_000);

  // The fleet comes from the app-wide ComputeHost, not a local copy. The old
  // localStorage mirror let this page and the dock disagree about which
  // computers existed, which showed up as a "clone into a workspace" that
  // landed in a box the terminal could not find.
  const { computers: boxes, create: createComputer, refresh: refreshFleet } = useCompute();

  const [linking, setLinking] = useState(false);
  // GitHub setup + discovery live on this page now — no detour to Knowledge →
  // Sources just to paste a PAT, and no typing owner/name from memory.
  const [showConnections, setShowConnections] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [repo, setRepo] = useState('');
  const [connection, setConnection] = useState('');
  const [orgProject, setOrgProject] = useState('');
  const [repoOptions, setRepoOptions] = useState<RepoRef[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  // The run box: one prompt, one project, fired into a workspace.
  const [runFor, setRunFor] = useState<Project | null>(null);
  const [prompt, setPrompt] = useState('');
  const [model, setModel] = useState(DEFAULT_DEVBOX_MODEL);

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
    // Accept a full GitHub URL (HTTPS/SSH) or owner/name.
    const fullName = parseRepoInput(repo);
    if (!fullName) {
      toastError(null, 'That doesn’t look like a repo',
        'Paste a GitHub URL (https://github.com/owner/repo or git@github.com:owner/repo.git) or type owner/name.');
      return;
    }
    setBusy('link');
    const tid = toastPending('Linking project', fullName);
    try {
      const res = await fetch('/api/agent-projects', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoFullName: fullName,
          connectionName: connection || null,
          orgProjectId: orgProject || null,
        }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Linked', `${fullName} is now a project.`);
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
      if (!box) box = await createComputer();

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
      // HTTP 200 only means the command *ran* — a git clone that failed (bad
      // repo, auth, private without a credential) still returns 200 with the
      // failure in the stream. Reporting that as "Cloned" sends the user on to a
      // run against an empty checkout, so inspect the output and the exit event.
      // Redact before anything reads it. The clone command carries a GitHub
      // token in the URL userinfo for a private repo, and git echoes the URL
      // back *verbatim* in `fatal: unable to access '<url>': ...` — it redacts
      // nothing there. The access-failure and network branches below replace
      // the text with hand-written messages, but the generic `fatal:` fallback
      // throws the matched git line straight into a toast, and a TLS, proxy or
      // curl error takes exactly that path: the token would be rendered in the
      // UI (and into any screenshot or copied error text). Scrubbing the whole
      // buffer at the source keeps every later reader safe by construction
      // rather than relying on each branch to remember.
      const out = redactUrlCredentials(await run.text());
      // The command's exit code is authoritative — the stream ends with an
      // {type:'exit', exitCode} event. Trust it over scanning for "fatal:":
      // a *successful* clone's verification step can still print a benign
      // "fatal: detected dubious ownership" (the checkout is owned by another
      // uid), and flagging on that text alone turns good clones into false
      // failures. Only fall back to text markers if no exit event arrived.
      const exitMatch = out.match(/"exitcode":\s*(\d+)/i);
      const failed = exitMatch
        ? exitMatch[1] !== '0'
        : /fatal:|repository not found|authentication failed|could not read username|could not resolve host|permission denied/i.test(out);
      if (failed) {
        // Translate the raw git failure into something actionable. An auth
        // prompt ("could not read Username"), auth failure, permission denied,
        // or "repository not found" all mean the same thing here: the clone
        // couldn't access the repo, almost always because it's private and no
        // credential was sent.
        const isAccess = /could not read username|authentication failed|permission denied|repository not found|invalid username or password/i.test(out);
        if (isAccess) {
          throw new Error(
            p.connectionName
              ? `Couldn't access ${p.repoFullName} with the “${p.connectionName}” credential — check that its token can reach this repository.`
              : `Couldn't access ${p.repoFullName}. It was linked as a public repo, so no credential was sent. If it's private, add a GitHub connection with the Connections button on this page and re-link it with that credential; if it's public, double-check the owner/name.`,
          );
        }
        if (/could not resolve host|network is unreachable|connection timed out/i.test(out)) {
          throw new Error(`Network error reaching GitHub while cloning ${p.repoFullName}. Try again in a moment.`);
        }
        const m = out.match(/(fatal:[^"\\\n]*|the clone did not complete[^"\\\n]*)/i);
        throw new Error(m ? m[0].slice(0, 200) : 'The clone did not complete — check the repository name and credential.');
      }

      // The clone exited 0 — only now confirm it so the project shows as
      // in-workspace. (Generating the command no longer marks it, so a failed
      // clone can't leave a phantom checkout with a broken "Open shell".)
      await fetch(`/api/agent-projects/${p.id}/cloned`, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: box.sessionId }),
      });
      toastSuccess(tid, 'Cloned', `${p.repoFullName} is in ${box.label}.`);
      void refreshFleet();
      refresh();
    } catch (err) {
      toastError(tid, 'Could not clone', (err as Error).message);
    } finally { setBusy(null); }
  }, [boxes, createComputer, refreshFleet, refresh]);

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
      setRunFor(null); setPrompt('');
      refresh();
    } catch (err) {
      toastError(tid, 'Could not start', (err as Error).message);
    } finally { setBusy(null); }
  }, [runFor, prompt, model, boxes, refresh]);

  const projects = data?.projects ?? [];
  const openChangesByProject = (changesData?.changes ?? []).reduce<Record<string, number>>((acc, c) => {
    acc[c.projectId] = (acc[c.projectId] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <PageSection
      title="Codebases"
      description="Repositories that agents work on, and the initiatives they deliver. What matters here is what the bots did — not the human collaboration furniture."
    >
      <Inline align="center" gap="sm" wrap className="mb-4">
        {canDevbox && (
          <>
            <Button variant="primary" size="sm" onClick={() => setLinking((v) => !v)}>
              {linking ? 'Cancel' : '+ Link a repository'}
            </Button>
            <Button
              variant="secondary" size="sm"
              disabled={githubConnections.length === 0}
              title={githubConnections.length === 0
                ? 'Connect GitHub first — discovery browses what a credential can see.'
                : 'Browse repositories by connection and organization'}
              onClick={() => setDiscovering(true)}
            >
              Discover
            </Button>
          </>
        )}
        <Button variant="secondary" size="sm" onClick={() => setShowConnections((v) => !v)}>
          {showConnections ? 'Hide connections' : 'Connections'}
        </Button>
        {githubConnections.length === 0 && canIngest && (
          <Inline align="center" gap="xs">
            <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">No GitHub connection yet</Inline>
            <Button variant="ghost" size="sm" onClick={() => setShowConnections(true)}>Add one here</Button>
            <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">— Knowledge → Sources also manages these; ingest shares the vault.</Inline>
          </Inline>
        )}
      </Inline>

      {showConnections && (
        <ConnectionSetup
          sources={connections?.sources ?? []}
          onChanged={refreshConnections}
        />
      )}

      {linking && (
        <Card padding="md" className="mb-4">
          <Stack gap="sm">
            <Inline gap="sm" align="end" wrap>
              <Stack as="label" gap="xs">
                <SectionLabel>Credential</SectionLabel>
                <Select
                  value={connection}
                  onChange={(e) => setConnection(e.target.value)}
                  options={[
                    { value: '', label: 'none (public repo)' },
                    ...githubConnections.map((c) => ({ value: c.name, label: c.name })),
                  ]}
                />
              </Stack>
              <Stack as="label" gap="xs" className="min-w-[240px] flex-1">
                <SectionLabel>Repository</SectionLabel>
                <Input
                  list="repo-options"
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void link(); }}
                  placeholder="Paste a GitHub URL (https:// or git@…) or owner/name"
                  mono
                />
                <datalist id="repo-options">
                  {repoOptions.map((r) => <option key={r.fullName} value={r.fullName} />)}
                </datalist>
              </Stack>
              <Stack as="label" gap="xs">
                <SectionLabel>Initiative</SectionLabel>
                <Select
                  value={orgProject}
                  onChange={(e) => setOrgProject(e.target.value)}
                  options={[
                    { value: '', label: 'unattached' },
                    ...(orgProjects ?? []).map((op) => ({ value: op.id, label: op.name })),
                  ]}
                />
              </Stack>
              <Button variant="primary" size="sm" disabled={busy === 'link' || !repo.trim()} onClick={() => void link()}>
                {busy === 'link' ? 'linking…' : 'Link'}
              </Button>
            </Inline>
            {connection && repoOptions.length > 0 && (
              <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">
                {repoOptions.length} repositories visible to this credential.
              </Inline>
            )}
          </Stack>
        </Card>
      )}

      {projects.length === 0 ? (
        <EmptyState
          title="No projects linked"
          body="Link a repository to clone it into a workspace and run agents against it. Public repositories need no credential."
        />
      ) : (
        <CatalogGrid columns={2}>
          {projects.map((p) => {
            const box = boxes.find((b) => b.sessionId === p.sessionId);
            const inWorkspace = Boolean(p.clonedAt && box);
            const focused = p.id === focusProject;
            // The focused card shows its full run history so a deep-linked run
            // is present even when it has scrolled out of the newest five.
            const runs = focused && focusRuns?.runs?.length ? focusRuns.runs : p.runs;
            return (
              <Card
                key={p.id}
                id={`project-${p.id}`}
                padding="none"
                className={focused ? 'ring-2 ring-primary/60' : undefined}
              >
                <Inline align="center" gap="sm" wrap justify="between" className="border-b border-border px-3.5 py-2.5">
                  <Inline align="center" gap="sm" wrap>
                    <ExternalLink external
                      href={`https://github.com/${p.repoFullName}`}
                      title={`Open ${p.repoFullName} on GitHub`}
                      className="inline-flex items-center gap-1 truncate font-mono text-[13px] font-semibold text-text-primary hover:text-primary hover:underline"
                    >
                      {p.repoFullName}
                      <Inline as="span" gap="none" className="text-[10px] text-text-tertiary" aria-hidden="true">↗</Inline>
                    </ExternalLink>
                    {!p.connectionName && <Chip size="xs">public</Chip>}
                    {p.orgProjectName && (
                      p.orgProjectId ? (
                        <Link
                          to={`/iq/projects/${p.orgProjectId}`}
                          title={`Open the initiative this codebase delivers: ${p.orgProjectName}`}
                          className="max-w-[40%] shrink-0 truncate rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary no-underline hover:underline"
                        >
                          {p.orgProjectName}
                        </Link>
                      ) : (
                        <Chip size="xs" tone="accent" title={`Delivers: ${p.orgProjectName}`}>{p.orgProjectName}</Chip>
                      )
                    )}
                  </Inline>
                  {canDevbox && (
                    <Button variant="ghost" size="sm" onClick={() => void unlink(p)}>unlink</Button>
                  )}
                </Inline>

                <Inline align="center" gap="sm" wrap justify="between" className="border-b border-border px-3.5 py-2.5">
                  {inWorkspace ? (
                    <>
                      <Inline align="center" gap="sm" wrap>
                        <Inline as="span" gap="none" className="text-[11px] text-success">in {box?.label}</Inline>
                        <Inline as="span" gap="none" className="truncate font-mono text-[11px] text-text-tertiary">{p.checkout}</Inline>
                      </Inline>
                      {canDevbox && (
                        <Inline gap="xs">
                          <Button variant="primary" size="sm" onClick={() => { setRunFor(p); setPrompt(''); }}>
                            Run a task
                          </Button>
                          <Button
                            variant="secondary" size="sm"
                            onClick={() => box && openShell({ id: box.id, label: box.label, sessionId: box.sessionId, cwd: p.checkout })}
                          >
                            Open shell
                          </Button>
                        </Inline>
                      )}
                    </>
                  ) : (
                    <>
                      <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">
                        {p.clonedAt
                          // A workspace is disposable; the project is not.
                          ? 'Its workspace is gone — microVMs are wiped by image pushes and expire when idle.'
                          : 'Not in a workspace yet.'}
                      </Inline>
                      {canDevbox && (
                        <Button variant="primary" size="sm" disabled={busy === `clone:${p.id}`} onClick={() => void clone(p)}>
                          {busy === `clone:${p.id}` ? 'cloning…' : p.clonedAt ? 'Re-clone' : 'Clone into workspace'}
                        </Button>
                      )}
                    </>
                  )}
                </Inline>

                {p.owners.length > 0 && (
                  <Inline as="span" gap="none" className="border-b border-border px-3.5 py-2 text-[11px] text-text-tertiary">
                    Accountable: {p.owners.map((o) => o.name + (o.role ? ` (${o.role})` : '')).join(', ')}
                  </Inline>
                )}

                {runs.length === 0 ? (
                  <Inline as="span" gap="none" className="px-3.5 py-3 text-[11px] text-text-tertiary">
                    Nothing has been run against this yet.
                  </Inline>
                ) : (
                  <Stack gap="none">
                    {runs.map((r) => (
                      <Inline
                        key={r.id}
                        align="start" gap="sm"
                        className={`border-b border-border px-3.5 py-2 last:border-b-0 ${
                          r.id === focusRun ? 'border-l-2 border-l-primary bg-primary/5' : ''}`}
                      >
                        <Chip tone={STATUS_TONE[r.status]} size="xs">{r.status}</Chip>
                        <Stack gap="none" className="min-w-0 flex-1">
                          <Inline as="span" gap="none" className="truncate text-[12px] text-text-primary" title={r.prompt}>{r.prompt}</Inline>
                          <MetaLine
                            size="xs"
                            items={[
                              relativeTime(r.startedAt),
                              r.model,
                              r.durationMs != null ? durationLabel(r.durationMs) : null,
                              r.filesChanged != null ? `${r.filesChanged} ${r.filesChanged === 1 ? 'file' : 'files'} changed` : null,
                              r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : null,
                            ]}
                          />
                          {r.diffSummary && (
                            <Inline as="span" gap="none" className="mt-0.5 truncate text-[11px] text-text-secondary" title={r.diffSummary}>
                              {r.diffSummary}
                            </Inline>
                          )}
                          {r.error && (
                            <Inline as="span" gap="none" className="mt-0.5 truncate text-[11px] text-danger">{r.error}</Inline>
                          )}
                        </Stack>
                      </Inline>
                    ))}
                  </Stack>
                )}

                {(openChangesByProject[p.id] ?? 0) > 0 && (
                  <Inline className="border-t border-border bg-warning-bg/40 px-3.5 py-2">
                    <Link to="/admin/changes" className="text-[11px] font-semibold text-warning no-underline hover:underline">
                      {openChangesByProject[p.id]} change{openChangesByProject[p.id] === 1 ? '' : 's'} awaiting review →
                    </Link>
                  </Inline>
                )}
              </Card>
            );
          })}
        </CatalogGrid>
      )}

      <RepoDiscovery
        open={discovering}
        onClose={() => setDiscovering(false)}
        connections={githubConnections}
        orgProjects={orgProjects ?? []}
        linkedFullNames={projects.map((p) => p.repoFullName)}
        onLinked={refresh}
      />

      {/* The run box. One prompt, one project — the thing you reach for. */}
      <Modal
        open={runFor != null}
        onClose={() => setRunFor(null)}
        title={runFor ? `Run on ${runFor.repoFullName}` : 'Run'}
        footer={
          <Inline align="center" justify="between" gap="sm" className="w-full">
            <Inline as="span" gap="none" className="text-[11px] text-text-tertiary">⌘⏎ to run · esc to close</Inline>
            <Button variant="primary" size="sm" disabled={busy === 'run' || !prompt.trim()} onClick={() => void run()}>
              {busy === 'run' ? 'starting…' : 'Run'}
            </Button>
          </Inline>
        }
      >
        <Stack gap="sm">
          <Textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
              if (e.key === 'Escape') setRunFor(null);
            }}
            rows={4}
            placeholder="Add a health check endpoint and a test for it. Commit on a branch."
          />
          <Select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            options={DEVBOX_MODELS.map((m) => ({ value: m.id, label: `${m.label} — ${m.hint}` }))}
          />
        </Stack>
      </Modal>
    </PageSection>
  );
}
