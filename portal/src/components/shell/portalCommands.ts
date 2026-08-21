// Portal-specific command catalog for the shared CommandPalette. Translates
// the OrgIQ tenant/role/path conventions into the generic Command[] surface
// exposed by @connorhoehnslalom/ui-components/shared.
//
// Three contributions:
//   1. usePortalCommands() — static page jumps + recent harness runs, gated
//      by tenant/role. Grouped by tenant for the SubNav-style heading.
//   2. usePortalDynamicCommands() — query-derived commands: a UUID-paste
//      shortcut that jumps to the invocation detail view.
//
// Note: the legacy '>' cross-tenant escape prefix is not carried over to the
// new lib (cmdk's filter doesn't have a clean opt-out per-item). If the
// affordance is missed in practice, revisit by setting forceMount on the
// synthetic commands.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { Command } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { openShell } from '../../lib/terminalDock';
import { loadBoxes } from '../../lib/devboxRegistry';

type PageTenant = 'orgiq' | 'newsroom' | 'admin' | 'universal';

interface PageEntry {
  label: string;
  hint: string;
  path: string;
  tenant: PageTenant;
}

interface RecentRun {
  runId: string;
  label?: string;
  startedAt?: string;
  passRate?: number | null;
  status?: string;
}

const PAGES: PageEntry[] = [
  { label: 'Ask',                hint: 'Ask the org-search agent',            path: '/iq/invoke',                                  tenant: 'orgiq' },
  { label: 'Explore',            hint: 'Force-directed org graph',            path: '/iq/explore',                                 tenant: 'orgiq' },
  { label: 'Architecture',       hint: 'A2A agent topology',                  path: '/iq/agents',                                  tenant: 'orgiq' },
  { label: 'Canary',             hint: 'Live A/B prompt rollout',             path: '/iq/canary',                                  tenant: 'orgiq' },
  { label: 'Scores',             hint: 'Per-person influence leaderboard',    path: '/iq/scores',                                  tenant: 'orgiq' },
  { label: 'Projects',           hint: 'Project contributions + decisions',   path: '/iq/projects',                                tenant: 'orgiq' },
  { label: 'Newsroom',           hint: 'Articles, beats, briefs, pitches',    path: '/newsroom',                                   tenant: 'newsroom' },
  { label: 'Newsroom — Articles',hint: 'Browse articles + filters',           path: '/newsroom/articles',                          tenant: 'newsroom' },
  { label: 'Newsroom — Beats',   hint: 'Coverage heatmap by topic',           path: '/newsroom/beats',                             tenant: 'newsroom' },
  { label: 'Knowledge Base',     hint: 'Documents + data sources',            path: '/admin/knowledge',                            tenant: 'admin' },
  { label: 'Settings',           hint: 'User preferences',                    path: '/settings',                                   tenant: 'universal' },
  { label: 'On-Call',            hint: 'Live alarms + incident timeline',     path: '/admin/observability/oncall',                 tenant: 'admin' },
  { label: 'Summary',            hint: 'Health overview',                     path: '/admin/observability/summary',                tenant: 'admin' },
  { label: 'Traffic',            hint: 'RPS + heatmap + top users',           path: '/admin/observability/traffic',                tenant: 'admin' },
  { label: 'Recent',             hint: 'Last 50 agent calls',                 path: '/admin/observability/invocations',            tenant: 'admin' },
  { label: 'Invocations Search', hint: 'Triage by prompt / agent / score',    path: '/admin/observability/invocations/search',     tenant: 'admin' },
  { label: 'Capability Events',  hint: 'Browser & code-interpreter events',   path: '/admin/observability/capability-events',      tenant: 'admin' },
  { label: 'Agent Metrics',      hint: 'Per-agent stats',                     path: '/admin/observability/agents',                 tenant: 'admin' },
  { label: 'Sessions',           hint: 'Chat threads',                        path: '/admin/observability/sessions',               tenant: 'admin' },
  { label: 'Authz Log',          hint: 'Live AVP / Cedar decisions',          path: '/admin/observability/authz',                  tenant: 'admin' },
  { label: 'Memory',             hint: 'Memory ops + cold sessions',          path: '/admin/observability/memory',                 tenant: 'admin' },
  { label: 'Guardrail Rules',    hint: 'Per-rule intervention details',       path: '/admin/observability/guardrail-rules',        tenant: 'admin' },
  { label: 'Drift',              hint: 'Schema + judge + embedding drift',    path: '/admin/observability/drift',                  tenant: 'admin' },
  { label: 'Quality',            hint: 'Judge scores + feedback',             path: '/admin/observability/quality',                tenant: 'admin' },
  { label: 'Cost',               hint: 'Spend by agent + deploy markers',     path: '/admin/observability/cost',                   tenant: 'admin' },
  { label: 'Approvals',          hint: 'Pending HITL decisions',              path: '/admin/observability/approvals',              tenant: 'admin' },
  { label: 'Harness',            hint: 'Replay test set + view runs',         path: '/admin/observability/harness',                tenant: 'admin' },
  { label: 'Calibration',        hint: 'Judge vs human MAE drift',            path: '/admin/observability/calibration',            tenant: 'admin' },
  { label: 'Prompts',            hint: 'Managed prompt registry',             path: '/iq/prompts',                                 tenant: 'admin' },
  { label: 'Model Compare',      hint: 'Side-by-side run delta',              path: '/admin/observability/model-compare',          tenant: 'admin' },
];

const ADMIN_ROLES = new Set(['hr-admin', 'org-leader', 'admin']);
// Palette gate must match the nav's requireRoles: Identity, Ingest and
// Knowledge are hr-admin-only. Uses the real /admin/knowledge path (the old
// /admin/knowledge-base is a redirect, so the gate never matched it).
const HR_ADMIN_PATHS = ['/admin/identity', '/admin/ingest', '/admin/knowledge'];
const UUID_RE = /^[0-9a-f-]{36}$/i;

function isHrAdminGated(path: string): boolean {
  return HR_ADMIN_PATHS.some((prefix) => path === prefix || path.startsWith(prefix + '/'));
}

function isPageVisible(page: PageEntry, tenant: string, role: string): boolean {
  if (page.tenant === 'universal') return true;
  if (role === 'admin') {
    if (page.tenant === 'admin') return true;
    return page.tenant === tenant;
  }
  if (isHrAdminGated(page.path) && role !== 'hr-admin') return false;
  if (page.tenant === 'admin') return ADMIN_ROLES.has(role);
  return page.tenant === tenant;
}

function groupLabel(tenant: PageTenant): string {
  switch (tenant) {
    case 'orgiq': return 'OrgIQ';
    case 'newsroom': return 'Newsroom';
    case 'admin': return 'Admin';
    case 'universal': return 'Universal';
  }
}

// Lazy-fetch recent harness runs the first time something asks for them.
// Results refresh once per session; the palette is reopened often enough
// that a manual refresh affordance isn't worth the surface.
function useRecentHarnessRuns(): RecentRun[] {
  const [runs, setRuns] = useState<RecentRun[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    fetch('/api/observability/harness/runs?limit=5', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        if (cancelled || !j) return;
        const raw = Array.isArray(j) ? j : ((j as { runs?: unknown }).runs ?? []);
        const list = Array.isArray(raw) ? (raw as RecentRun[]) : [];
        setRuns(list.slice(0, 5));
      })
      .catch(() => { /* silent */ })
      .finally(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [loaded]);

  return runs;
}

/**
 * Composes the static page-jump catalog (tenant/role-filtered) with recent
 * harness runs into a single Command[] suitable for the CommandPalette.
 */
export function usePortalCommands(): Command[] {
  const navigate = useNavigate();
  const { session } = useSession();
  const tenant = session?.tenant ?? 'orgiq';
  const role = session?.role ?? 'member';
  const runs = useRecentHarnessRuns();

  return useMemo<Command[]>(() => {
    const pageCommands: Command[] = PAGES
      .filter((p) => isPageVisible(p, tenant, role))
      .map((p) => ({
        id: `page:${p.path}`,
        label: p.label,
        hint: p.hint,
        group: groupLabel(p.tenant),
        keywords: [p.path],
        run: () => { navigate(p.path); },
      }));

    const runCommands: Command[] = runs.map((r) => ({
      id: `run:${r.runId}`,
      label: `Run · ${r.label ?? r.runId}`,
      hint: `${r.status ?? 'run'} · ${r.runId.slice(0, 8)}`,
      group: 'Recent runs',
      keywords: [r.runId, 'run', 'harness'],
      run: () => { navigate(`/admin/observability/harness/runs/${r.runId}`); },
    }));

    return [...pageCommands, ...runCommands];
  }, [navigate, tenant, role, runs]);
}

/**
 * Query-derived commands: when the user pastes a UUID, surface a single
 * synthetic "Open invocation" command that jumps to the invocation detail.
 */
export function usePortalDynamicCommands(): (query: string) => Command[] {
  const navigate = useNavigate();

  return useCallback((query: string): Command[] => {
    const q = query.trim();

    // Terminals from anywhere. The dock has hotkeys, but a hotkey cannot open
    // the FIRST shell — you have to pick a box — and the palette is where this
    // app already puts "do a thing without navigating".
    const wantsShell = /^(term|shell|tty|ssh|console)/i.test(q);
    if (wantsShell || q === '') {
      const boxes = loadBoxes();
      const shellCommands: Command[] = boxes.map((b) => ({
        id: `shell:${b.id}`,
        label: `Terminal → ${b.label}`,
        hint: 'open a shell in this devbox',
        group: 'Terminals',
        keywords: ['terminal', 'shell', 'tty', 'console', b.label, b.id],
        run: () => { openShell({ id: b.id, label: b.label, sessionId: b.sessionId }); },
      }));
      if (boxes.length === 0 && wantsShell) {
        shellCommands.push({
          id: 'shell:none',
          label: 'No computers yet — open Computers to create one',
          hint: 'a terminal needs a box to attach to',
          group: 'Terminals',
          keywords: ['terminal', 'shell'],
          run: () => { navigate('/admin/devbox'); },
        });
      }
      if (wantsShell) return shellCommands;
      if (shellCommands.length) return shellCommands;
    }

    if (!UUID_RE.test(q)) return [];
    const prefix = q.slice(0, 8);
    return [
      {
        id: `uuid:${q}`,
        label: `Open invocation ${prefix} →`,
        hint: q,
        group: 'Direct jump',
        // Seed keywords with the query itself so cmdk's matcher doesn't drop it.
        keywords: [q, prefix, 'invocation', 'uuid'],
        run: () => { navigate(`/admin/observability/invocations/${q}`); },
      },
    ];
  }, [navigate]);
}
