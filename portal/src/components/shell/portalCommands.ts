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
  /** Palette group — mirrors the rail's Build/Org/Operate/System grouping. */
  group: string;
  /** Roles that may open it; omitted = any role in the right tenant. The
      cross-tenant 'admin' role bypasses this, same as the nav and routes. */
  roles?: string[];
}

interface RecentRun {
  runId: string;
  label?: string;
  startedAt?: string;
  passRate?: number | null;
  status?: string;
}

// The full navigable surface, grouped the way the rail groups it. Every page
// with a rail or sub-rail entry is here; gates mirror the routes' RequireRole
// so the palette never offers a jump that bounces.
const PLATFORM = ['org-leader', 'hr-admin'];
const BUILD = ['hr-admin'];

const PAGES: PageEntry[] = [
  // ── Build — the SDLC loop ──
  { label: 'Work',               hint: 'Findings, jobs, proposals',           path: '/iq/work',                                    tenant: 'orgiq',  group: 'Build' },
  { label: 'Graph updates',      hint: 'What reached the org graph',          path: '/iq/work/changes',                            tenant: 'orgiq',  group: 'Build' },
  { label: 'Initiatives',        hint: 'Epics, decisions, contributors',      path: '/iq/projects',                                tenant: 'orgiq',  group: 'Build' },
  { label: 'Codebases',          hint: 'Repos agents work on + runs',         path: '/admin/projects',                             tenant: 'admin',  group: 'Build',   roles: BUILD },
  { label: 'Changes',            hint: 'Code review queue + policies',        path: '/admin/changes',                              tenant: 'admin',  group: 'Build',   roles: BUILD },
  { label: 'Computers',          hint: 'MicroVM fleet + task runner',         path: '/admin/devbox',                               tenant: 'admin',  group: 'Build',   roles: BUILD },
  // ── Org — organizational intelligence ──
  { label: 'Ask',                hint: 'Ask the org-search agent',            path: '/iq/invoke',                                  tenant: 'orgiq',  group: 'Org' },
  { label: 'Explore',            hint: 'Force-directed org graph',            path: '/iq/explore',                                 tenant: 'orgiq',  group: 'Org' },
  { label: 'Scores',             hint: 'Per-person influence leaderboard',    path: '/iq/scores',                                  tenant: 'orgiq',  group: 'Org' },
  { label: 'Score cohorts',      hint: 'Scores grouped by team',              path: '/iq/scores/cohorts',                          tenant: 'orgiq',  group: 'Org' },
  { label: 'Score compare',      hint: 'Radar overlay of people',             path: '/iq/scores/compare',                          tenant: 'orgiq',  group: 'Org' },
  // ── Operate — prompts, health, platform ──
  { label: 'Prompt Ops',         hint: 'Prompt management overview',          path: '/iq/prompt-ops',                              tenant: 'orgiq',  group: 'Operate' },
  { label: 'Prompt Studio',      hint: 'Managed prompt registry',             path: '/iq/prompts',                                 tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Prompt History',     hint: 'Version timeline per prompt',         path: '/iq/history',                                 tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Prompt Diff',        hint: 'Compare two prompt versions',         path: '/iq/diff',                                    tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Canary',             hint: 'Live A/B prompt rollout',             path: '/iq/canary',                                  tenant: 'orgiq',  group: 'Operate' },
  { label: 'Evaluations',        hint: 'LLM-as-judge configuration',          path: '/iq/evaluations',                             tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Architecture',       hint: 'A2A agent topology',                  path: '/iq/agents',                                  tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Knowledge',          hint: 'Pipeline health + registry',          path: '/admin/knowledge',                            tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Ingest sources',     hint: 'What content is pulled in',           path: '/admin/ingest/crawl',                         tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'Ingest runs',        hint: 'What each pull did',                  path: '/admin/ingest/history',                       tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'Ingest storage',     hint: 'Where documents land',                path: '/admin/ingest/storage',                       tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'KB sync',            hint: 'Storage → knowledge base',            path: '/admin/ingest/sources',                       tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'Ingest schedule',    hint: 'How often it re-syncs',               path: '/admin/ingest/schedules',                     tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'Capabilities',       hint: 'Guardrails, browser, interpreter',    path: '/admin/capabilities',                         tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'On-Call',            hint: 'Live alarms + incident timeline',     path: '/admin/observability/oncall',                 tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Health',             hint: 'Health overview',                     path: '/admin/observability/summary',                tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Traffic',            hint: 'RPS + heatmap + top users',           path: '/admin/observability/traffic',                tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Runs',               hint: 'Last 50 agent calls',                 path: '/admin/observability/invocations',            tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Invocations Search', hint: 'Triage by prompt / agent / score',    path: '/admin/observability/invocations/search',     tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Capability Events',  hint: 'Browser & code-interpreter events',   path: '/admin/observability/capability-events',      tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Agent Metrics',      hint: 'Per-agent stats',                     path: '/admin/observability/agents',                 tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Sessions',           hint: 'Chat threads',                        path: '/admin/observability/sessions',               tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Authz Log',          hint: 'Live AVP / Cedar decisions',          path: '/admin/observability/authz',                  tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Memory',             hint: 'Memory ops + cold sessions',          path: '/admin/observability/memory',                 tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Guardrail Rules',    hint: 'Per-rule intervention details',       path: '/admin/observability/guardrail-rules',        tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Drift',              hint: 'Schema + judge + embedding drift',    path: '/admin/observability/drift',                  tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Quality',            hint: 'Judge scores + feedback',             path: '/admin/observability/quality',                tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Cost',               hint: 'Spend by agent + deploy markers',     path: '/admin/observability/cost',                   tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Approvals',          hint: 'Pending HITL decisions',              path: '/admin/observability/approvals',              tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Harness',            hint: 'Replay test set + view runs',         path: '/admin/observability/harness',                tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Calibration',        hint: 'Judge vs human MAE drift',            path: '/admin/observability/calibration',            tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Model Compare',      hint: 'Side-by-side run delta',              path: '/admin/observability/model-compare',          tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  // ── System — administration ──
  { label: 'Identity',           hint: 'Users, roles, Cedar policies',        path: '/admin/identity',                             tenant: 'admin',  group: 'System',  roles: BUILD },
  { label: 'Policy sandbox',     hint: 'Dry-run an authz decision',           path: '/admin/identity/test',                        tenant: 'admin',  group: 'System',  roles: BUILD },
  { label: 'Settings',           hint: 'User preferences',                    path: '/settings',                                   tenant: 'universal', group: 'System' },
  // ── Newsroom tenant ──
  { label: 'Newsroom',           hint: 'Today at a glance',                   path: '/newsroom',                                   tenant: 'newsroom', group: 'Newsroom' },
  { label: 'Articles',           hint: 'Browse articles + filters',           path: '/newsroom/articles',                          tenant: 'newsroom', group: 'Newsroom' },
  { label: 'Beats',              hint: 'Coverage heatmap by topic',           path: '/newsroom/beats',                             tenant: 'newsroom', group: 'Newsroom' },
  { label: 'Researcher',         hint: 'Story research agent',                path: '/newsroom/researcher',                        tenant: 'newsroom', group: 'Newsroom' },
  { label: 'Briefs',             hint: 'Generated digests',                   path: '/newsroom/briefs',                            tenant: 'newsroom', group: 'Newsroom' },
  { label: 'Headlines',          hint: 'A/B variants for any draft',          path: '/newsroom/headlines',                         tenant: 'newsroom', group: 'Newsroom' },
  { label: 'Pitches',            hint: 'Story backlog + desk decisions',      path: '/newsroom/pitches',                           tenant: 'newsroom', group: 'Newsroom' },
];

const UUID_RE = /^[0-9a-f-]{36}$/i;

function isPageVisible(page: PageEntry, tenant: string, role: string): boolean {
  if (page.tenant === 'universal') return true;
  // Platform pages (tenant 'admin') are org-tenant surfaces — same scoping as
  // the rail: a session parked on newsroom doesn't get org platform jumps.
  if (page.tenant === 'admin') {
    if (tenant !== 'orgiq') return false;
    if (role === 'admin') return true;
    return !page.roles || page.roles.includes(role);
  }
  if (page.tenant !== tenant) return false;
  if (role === 'admin') return true;
  return !page.roles || page.roles.includes(role);
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
        group: p.group,
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
        hint: 'open a shell in this computer',
        group: 'Terminals',
        keywords: ['terminal', 'shell', 'tty', 'console', b.label, b.id],
        run: () => { openShell({ id: b.id, label: b.label, sessionId: b.sessionId }); },
      }));
      if (boxes.length === 0 && wantsShell) {
        shellCommands.push({
          id: 'shell:none',
          label: 'No computers yet — open Computers to create one',
          hint: 'a terminal needs a computer to attach to',
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
