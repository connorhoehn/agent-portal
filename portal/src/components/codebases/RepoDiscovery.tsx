// Repository discovery — a lazy tree over what each credential can see.
//
// Pasting owner/name works until it doesn't: a typo fails an hour later at
// clone time, and nobody remembers which org a repo lives in. Discovery walks
// the other direction — connection → personal / orgs → repositories — so
// linking is a pick from what GitHub says exists, not a guess about it.
//
// Each level is fetched on first expand and cached for the drawer's lifetime.
// The chevron style matches the workspace tree on the Devbox page.

import { useCallback, useState } from 'react';
import { Drawer } from '@connorhoehnslalom/ui-components/shared';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';

interface OrgRef { login: string; description: string | null }
interface RepoRef { owner: string; name: string; fullName: string; pushedAt?: string | null }
interface OrgProject { id: string; name: string; status: string | null }

interface Level<T> { loading: boolean; error: string | null; items: T[] | null }

interface Props {
  open: boolean;
  onClose: () => void;
  /** GitHub connections only — each tree root is one credential. */
  connections: Array<{ name: string }>;
  /** The page's already-fetched initiatives, for the link confirm row. */
  orgProjects: OrgProject[];
  /** fullNames already linked as projects — pre-marked, not re-linkable. */
  linkedFullNames: string[];
  /** Called after a successful link so the page refreshes its project list. */
  onLinked: () => void;
}

function ago(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (Number.isNaN(mins)) return null;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round(mins / 1440);
  return days < 365 ? `${days}d ago` : `${Math.round(days / 365)}y ago`;
}

function describeFailure(status: number, body: { error?: string }): string {
  if (status === 403) {
    return 'You don’t have permission to browse connections — this needs ManageIngest (the hr-admin role).';
  }
  return body.error ?? `HTTP ${status}`;
}

const CHEVRON = 'text-[9px] w-2 shrink-0';
const NODE = 'flex items-center gap-1.5 text-[12px] cursor-pointer hover:underline py-1';

export function RepoDiscovery({ open, onClose, connections, orgProjects, linkedFullNames, onLinked }: Props) {
  const [expandedConns, setExpandedConns] = useState<Set<string>>(new Set());
  // Owner key: `<connection>|<org login>` — empty login means Personal.
  const [expandedOwners, setExpandedOwners] = useState<Set<string>>(new Set());
  const [orgsByConn, setOrgsByConn] = useState<Record<string, Level<OrgRef>>>({});
  const [reposByOwner, setReposByOwner] = useState<Record<string, Level<RepoRef>>>({});

  // The inline confirm row under one repo, and repos linked this session.
  const [confirmFor, setConfirmFor] = useState<string | null>(null);
  const [orgProject, setOrgProject] = useState('');
  const [linking, setLinking] = useState(false);
  const [justLinked, setJustLinked] = useState<Set<string>>(new Set());

  const linked = new Set([...linkedFullNames, ...justLinked]);

  const loadOrgs = useCallback(async (conn: string) => {
    setOrgsByConn((m) => ({ ...m, [conn]: { loading: true, error: null, items: null } }));
    try {
      const res = await fetch(`/api/connections/${encodeURIComponent(conn)}/github/orgs`, {
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({})) as { orgs?: OrgRef[]; error?: string };
      if (!res.ok) throw new Error(describeFailure(res.status, body));
      setOrgsByConn((m) => ({ ...m, [conn]: { loading: false, error: null, items: body.orgs ?? [] } }));
    } catch (err) {
      setOrgsByConn((m) => ({ ...m, [conn]: { loading: false, error: (err as Error).message, items: null } }));
    }
  }, []);

  const loadRepos = useCallback(async (conn: string, org: string) => {
    const key = `${conn}|${org}`;
    setReposByOwner((m) => ({ ...m, [key]: { loading: true, error: null, items: null } }));
    try {
      const qs = `limit=50${org ? `&org=${encodeURIComponent(org)}` : ''}`;
      const res = await fetch(`/api/connections/${encodeURIComponent(conn)}/github/repos?${qs}`, {
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({})) as { repos?: RepoRef[]; error?: string };
      if (!res.ok) throw new Error(describeFailure(res.status, body));
      setReposByOwner((m) => ({ ...m, [key]: { loading: false, error: null, items: body.repos ?? [] } }));
    } catch (err) {
      setReposByOwner((m) => ({ ...m, [key]: { loading: false, error: (err as Error).message, items: null } }));
    }
  }, []);

  const toggleConn = useCallback((conn: string) => {
    setExpandedConns((prev) => {
      const next = new Set(prev);
      if (next.has(conn)) { next.delete(conn); return next; }
      next.add(conn);
      return next;
    });
    if (!expandedConns.has(conn) && !orgsByConn[conn]) void loadOrgs(conn);
  }, [expandedConns, orgsByConn, loadOrgs]);

  const toggleOwner = useCallback((conn: string, org: string) => {
    const key = `${conn}|${org}`;
    setExpandedOwners((prev) => {
      const next = new Set(prev);
      if (next.has(key)) { next.delete(key); return next; }
      next.add(key);
      return next;
    });
    if (!expandedOwners.has(key) && !reposByOwner[key]) void loadRepos(conn, org);
  }, [expandedOwners, reposByOwner, loadRepos]);

  const link = useCallback(async (conn: string, repo: RepoRef) => {
    setLinking(true);
    const tid = toastPending('Linking project', repo.fullName);
    try {
      const res = await fetch('/api/agent-projects', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repoFullName: repo.fullName,
          connectionName: conn,
          orgProjectId: orgProject || null,
        }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      toastSuccess(tid, 'Linked', `${repo.fullName} is now a project.`);
      setJustLinked((prev) => new Set(prev).add(repo.fullName));
      setConfirmFor(null); setOrgProject('');
      onLinked();
    } catch (err) {
      toastError(tid, 'Could not link', (err as Error).message);
    } finally { setLinking(false); }
  }, [orgProject, onLinked]);

  const renderRepos = (conn: string, org: string, depth: number) => {
    const key = `${conn}|${org}`;
    const level = reposByOwner[key];
    const pad = 14 + depth * 14;
    if (!level || level.loading) {
      return <div className="text-[11px] text-text-tertiary py-1" style={{ paddingLeft: pad }}>loading…</div>;
    }
    if (level.error) {
      return <div className="text-[11px] text-danger py-1" style={{ paddingLeft: pad }}>{level.error}</div>;
    }
    if ((level.items ?? []).length === 0) {
      return <div className="text-[11px] text-text-tertiary py-1" style={{ paddingLeft: pad }}>no repositories visible here</div>;
    }
    return (level.items ?? []).map((r) => {
      const rowKey = `${conn}|${r.fullName}`;
      const isLinked = linked.has(r.fullName);
      const confirming = confirmFor === rowKey;
      const pushed = ago(r.pushedAt);
      return (
        <div key={rowKey}>
          <div className="flex items-center gap-2 py-1" style={{ paddingLeft: pad }}>
            <span className="text-[12px] font-mono text-text-primary truncate" title={r.fullName}>{r.name}</span>
            {pushed && <span className="text-[10px] text-text-tertiary shrink-0">pushed {pushed}</span>}
            <div className="flex-1" />
            {isLinked ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-success-bg text-success shrink-0">linked</span>
            ) : (
              <button
                onClick={() => { setConfirmFor(confirming ? null : rowKey); setOrgProject(''); }}
                className="px-2 py-0.5 rounded-md border border-border bg-surface text-[11px] text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors shrink-0"
              >
                {confirming ? 'cancel' : 'Link'}
              </button>
            )}
          </div>
          {confirming && !isLinked && (
            <div className="flex items-center gap-2 pb-1.5" style={{ paddingLeft: pad + 8 }}>
              <select
                value={orgProject}
                onChange={(e) => setOrgProject(e.target.value)}
                className="px-2 py-1 rounded-md border border-border bg-surface text-[11px] text-text-primary"
              >
                <option value="">no initiative</option>
                {orgProjects.map((op) => <option key={op.id} value={op.id}>{op.name}</option>)}
              </select>
              <button
                disabled={linking}
                onClick={() => void link(conn, r)}
                className="px-2.5 py-1 rounded-md border-none bg-primary text-white text-[11px] font-semibold cursor-pointer disabled:opacity-40"
              >
                {linking ? 'linking…' : `Link ${r.fullName}`}
              </button>
            </div>
          )}
        </div>
      );
    });
  };

  const renderOwner = (conn: string, org: string, label: string, hint: string | null, depth: number) => {
    const key = `${conn}|${org}`;
    const isOpen = expandedOwners.has(key);
    return (
      <div key={key}>
        <div
          onClick={() => toggleOwner(conn, org)}
          className={`${NODE} text-text-primary`}
          style={{ paddingLeft: depth * 14 }}
          title={hint ?? undefined}
        >
          <span aria-hidden="true" className={CHEVRON}>{isOpen ? '▾' : '▸'}</span>
          <span className="truncate">{label}</span>
          {hint && <span className="text-[10px] text-text-tertiary truncate">{hint}</span>}
        </div>
        {isOpen && renderRepos(conn, org, depth + 1)}
      </div>
    );
  };

  return (
    <Drawer open={open} onClose={onClose} title="Discover repositories" width={480}>
      <div className="text-[11px] text-text-tertiary mb-2 leading-snug">
        What each credential can see on GitHub — expand a connection, pick an owner, link a
        repository. Pasting a URL on the page still works; this is the browsable route.
      </div>
      {connections.length === 0 ? (
        <div className="text-[12px] text-text-tertiary">
          No GitHub connections yet — add one from the Connections section on this page.
        </div>
      ) : (
        connections.map((c) => {
          const isOpen = expandedConns.has(c.name);
          const orgs = orgsByConn[c.name];
          return (
            <div key={c.name}>
              <div onClick={() => toggleConn(c.name)} className={`${NODE} font-mono text-primary`}>
                <span aria-hidden="true" className={CHEVRON}>{isOpen ? '▾' : '▸'}</span>
                <span className="truncate">{c.name}</span>
              </div>
              {isOpen && (
                !orgs || orgs.loading ? (
                  <div className="text-[11px] text-text-tertiary py-1 pl-3.5">loading…</div>
                ) : orgs.error ? (
                  <div className="text-[11px] text-danger py-1 pl-3.5">{orgs.error}</div>
                ) : (
                  <>
                    {renderOwner(c.name, '', 'Personal', 'repositories the token’s user can see', 1)}
                    {(orgs.items ?? []).map((o) =>
                      renderOwner(c.name, o.login, o.login, o.description, 1))}
                    {(orgs.items ?? []).length === 0 && (
                      <div className="text-[11px] text-text-tertiary py-1" style={{ paddingLeft: 28 }}>
                        no organizations — only Personal is browsable
                      </div>
                    )}
                  </>
                )
              )}
            </div>
          );
        })
      )}
    </Drawer>
  );
}
