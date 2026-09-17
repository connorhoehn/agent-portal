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
import {
  Button, Chip, Drawer, Inline, MetaLine, SectionLabel, Select, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useCapabilities } from '../../lib/capabilities';
import { toastError, toastSuccess, toastPending } from '../../lib/toastStore';
import { pgTimestampMs } from '../../lib/pgTimestamp.ts';

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
  // Through lib/pgTimestamp, not a bare `new Date(iso)`. Measured rather than
  // assumed: V8 accepts the raw wire shape `2026-09-08 08:19:23+00`, so this
  // was not broken; it is the half-normalised `…T…+00` that is Invalid Date.
  // Routed through the shared parser anyway for the reason pgTimestamp.ts's
  // own header gives: "one question answered by two functions is how the two
  // answers drift apart."
  const mins = Math.round((Date.now() - pgTimestampMs(iso)) / 60000);
  if (Number.isNaN(mins)) return null;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  const days = Math.round(mins / 1440);
  return days < 365 ? `${days}d ago` : `${Math.round(days / 365)}y ago`;
}

function describeFailure(status: number, body: { error?: string }): string {
  if (status === 403) {
    return 'You don’t have permission to browse connections — this needs the hr-admin role.';
  }
  return body.error ?? `HTTP ${status}`;
}

const CHEVRON = 'text-[9px] w-2 shrink-0';
const NODE = 'flex items-center gap-1.5 text-[12px] cursor-pointer hover:underline py-1';

/**
 * Row indent as a class rather than a computed `paddingLeft`.
 *
 * The tree is exactly three levels by construction — connection → owner →
 * repository — and both `renderOwner` call sites pass depth 1, so the padding
 * values are a closed set {14, 28, 42, 50}. Tailwind cannot build a class from
 * a runtime number, but it does not have to: a bounded set of depths is a
 * bounded set of classes, and that keeps the component-discipline rule (no JSX
 * `style=`) without pretending the tree is arbitrarily deep.
 */
const INDENT: Record<number, string> = {
  14: 'pl-3.5',
  28: 'pl-7',
  42: 'pl-[42px]',
  50: 'pl-[50px]',
};
const indent = (px: number): string => INDENT[px] ?? 'pl-3.5';

/**
 * One expandable row of the discovery tree: chevron, label, optional hint.
 *
 * The owner row and the connection row were the same three elements written
 * twice. One component means the tree's row shape is stated once, and the
 * chevron/label/hint stop being three loose spans per call site.
 */
function TreeRow({ open, label, hint, indentClass, onToggle }: {
  open: boolean;
  label: string;
  hint?: string | null;
  indentClass?: string;
  onToggle: () => void;
}) {
  return (
    <Inline
      gap="xs"
      align="center"
      onClick={onToggle}
      className={`${NODE} text-text-primary ${indentClass ?? ''}`}
      title={hint ?? undefined}
    >
      <Chip size="xs" tone="neutral" aria-hidden="true" className={CHEVRON}>{open ? '▾' : '▸'}</Chip>
      <SectionLabel className="truncate">{label}</SectionLabel>
      {hint && <MetaLine size="xs" className="truncate" items={[hint]} />}
    </Inline>
  );
}

export function RepoDiscovery({ open, onClose, connections, orgProjects, linkedFullNames, onLinked }: Props) {
  // Linking POSTs /api/agent-projects (ManageDevbox); browsing rides
  // /api/connections and surfaces its own 403 message when ManageIngest is
  // missing.
  const { can, ready } = useCapabilities();
  const canLink = ready && can('ManageDevbox');
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
      return <MetaLine size="xs" className={`py-1 ${indent(pad)}`} items={['loading…']} />;
    }
    if (level.error) {
      return <MetaLine size="xs" className={`py-1 text-danger ${indent(pad)}`} items={[level.error]} />;
    }
    if ((level.items ?? []).length === 0) {
      return <MetaLine size="xs" className={`py-1 ${indent(pad)}`} items={['no repositories visible here']} />;
    }
    return (level.items ?? []).map((r) => {
      const rowKey = `${conn}|${r.fullName}`;
      const isLinked = linked.has(r.fullName);
      const confirming = confirmFor === rowKey;
      const pushed = ago(r.pushedAt);
      return (
        <Stack key={rowKey} gap="none">
          <Inline gap="sm" align="center" justify="between" className={`py-1 ${indent(pad)}`}>
            <Chip size="xs" mono title={r.fullName} className="truncate">{r.name}</Chip>
            {pushed && <MetaLine size="xs" className="shrink-0" items={[`pushed ${pushed}`]} />}
            {isLinked ? (
              <Chip size="xs" tone="success" className="shrink-0">linked</Chip>
            ) : !canLink ? null : (
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0"
                onClick={() => { setConfirmFor(confirming ? null : rowKey); setOrgProject(''); }}
              >
                {confirming ? 'cancel' : 'Link'}
              </Button>
            )}
          </Inline>
          {confirming && !isLinked && (
            <Inline gap="sm" align="center" className={`pb-1.5 ${indent(pad + 8)}`}>
              <Select
                size="sm"
                value={orgProject}
                onChange={(e) => setOrgProject(e.target.value)}
                options={[
                  { value: '', label: 'no initiative' },
                  ...orgProjects.map((op) => ({ value: op.id, label: op.name })),
                ]}
              />
              <Button
                variant="primary"
                size="sm"
                disabled={linking}
                onClick={() => void link(conn, r)}
              >
                {linking ? 'linking…' : `Link ${r.fullName}`}
              </Button>
            </Inline>
          )}
        </Stack>
      );
    });
  };

  const renderOwner = (conn: string, org: string, label: string, hint: string | null, depth: number) => {
    const key = `${conn}|${org}`;
    const isOpen = expandedOwners.has(key);
    return (
      <Stack key={key} gap="none">
        <TreeRow
          open={isOpen}
          label={label}
          hint={hint}
          indentClass={indent(depth * 14)}
          onToggle={() => toggleOwner(conn, org)}
        />
        {isOpen && renderRepos(conn, org, depth + 1)}
      </Stack>
    );
  };

  return (
    <Drawer open={open} onClose={onClose} title="Discover repositories" width={480}>
      <MetaLine
        size="xs"
        className="mb-2 leading-snug"
        items={['What each credential can see on GitHub — expand a connection, pick an owner, link a repository. Pasting a URL on the page still works; this is the browsable route.']}
      />
      {connections.length === 0 ? (
        <MetaLine
          size="sm"
          items={['No GitHub connections yet — add one from the Connections section on this page.']}
        />
      ) : (
        connections.map((c) => {
          const isOpen = expandedConns.has(c.name);
          const orgs = orgsByConn[c.name];
          return (
            <Stack key={c.name} gap="none">
              <TreeRow
                open={isOpen}
                label={c.name}
                indentClass="font-mono text-primary"
                onToggle={() => toggleConn(c.name)}
              />
              {isOpen && (
                !orgs || orgs.loading ? (
                  <MetaLine size="xs" className="py-1 pl-3.5" items={['loading…']} />
                ) : orgs.error ? (
                  <MetaLine size="xs" className="py-1 pl-3.5 text-danger" items={[orgs.error]} />
                ) : (
                  <>
                    {renderOwner(c.name, '', 'Personal', 'repositories the token’s user can see', 1)}
                    {(orgs.items ?? []).map((o) =>
                      renderOwner(c.name, o.login, o.login, o.description, 1))}
                    {(orgs.items ?? []).length === 0 && (
                      <MetaLine
                        size="xs"
                        className="py-1 pl-7"
                        items={['no organizations — only Personal is browsable']}
                      />
                    )}
                  </>
                )
              )}
            </Stack>
          );
        })
      )}
    </Drawer>
  );
}
