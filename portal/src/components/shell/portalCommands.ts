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
import { openShell, useComputeOptional } from '@connorhoehnslalom/ui-components/compute';

type PageTenant = 'orgiq' | 'assessment' | 'admin' | 'universal';

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
// Each list mirrors the Cedar grant behind the route (middleware/seeds/roles/orgiq/*.cedar)
// and the matching RequireRole in App.tsx — the palette never offers a jump that bounces.
const PLATFORM = ['org-leader', 'hr-admin'];
const BUILD = ['hr-admin'];
const BUDGETS = ['program-owner', 'org-leader', 'hr-admin'];   // ManageBudgets
const BOTS = ['sme', 'program-owner', 'org-leader', 'hr-admin']; // ManageBots
const DEVBOX = ['sme', 'hr-admin'];                              // ManageDevbox
const CHANGES = ['program-owner', 'hr-admin'];

// Rail group order per tenant (top → bottom): the org tenant reads along its
// SDLC arc; the assessment tenant top-down through its own programme. The
// rail and the palette share this so ⌘K lists pages in the order the rail
// shows them — a group a tenant doesn't list sorts last, never vanishes.
export const GROUP_ORDER_BY_TENANT: Record<string, string[]> = {
  orgiq: ['Plan', 'Design', 'Build', 'Release', 'Operate', 'Org', 'System'],
  assessment: ['Assess', 'Analyze', 'Informatics', 'System'],
};
export function groupRank(tenant: string, group?: string): number {
  const order = GROUP_ORDER_BY_TENANT[tenant] ?? GROUP_ORDER_BY_TENANT['orgiq']!;
  const n = order.indexOf(group ?? 'System');
  return n < 0 ? order.length : n;
}

const PAGES: PageEntry[] = [
  // ── Plan → Build — the SDLC loop (Plan rows lead the rail; the palette groups by `group`) ──
  { label: 'Automate',           hint: 'The agent loop — queue, bots, review', path: '/iq/work',                                    tenant: 'orgiq',  group: 'Build' },
  { label: 'Graph updates',      hint: 'What reached the org graph',          path: '/iq/work/changes',                            tenant: 'orgiq',  group: 'Build' },
  { label: 'Initiatives',        hint: 'Epics, decisions, contributors',      path: '/iq/projects',                                tenant: 'orgiq',  group: 'Plan' },
  { label: 'Library',            hint: 'Every prompt, evaluator, skill and insight', path: '/iq/library',                          tenant: 'orgiq',  group: 'Design' },
  { label: 'Promotions',         hint: 'Candidate skills awaiting approval',  path: '/iq/promotions',                              tenant: 'orgiq',  group: 'Design' },
  { label: 'Designs',            hint: 'Design threads and sign-off',         path: '/iq/designs',                                 tenant: 'orgiq',  group: 'Design' },
  { label: 'Session config',     hint: 'The skill bundle agents start with',  path: '/iq/release',                                 tenant: 'orgiq',  group: 'Release' },
  { label: 'Budgets',            hint: 'Agent spend vs allocation',           path: '/admin/budgets',                              tenant: 'admin',  group: 'Plan',    roles: BUDGETS },
  { label: 'Bots',               hint: 'Mission-configured agents',           path: '/admin/bots',                                 tenant: 'admin',  group: 'Build',   roles: BOTS },
  { label: 'Codebases',          hint: 'Repos agents work on + runs',         path: '/admin/projects',                             tenant: 'admin',  group: 'Build',   roles: BUILD },
  { label: 'Changes',            hint: 'Code review queue + policies',        path: '/admin/changes',                              tenant: 'admin',  group: 'Build',   roles: CHANGES },
  { label: 'Computer Lab',       hint: 'MicroVM fleet + task runner',         path: '/admin/devbox',                               tenant: 'admin',  group: 'Build',   roles: DEVBOX },
  { label: 'Local compute',      hint: 'Your paired machines — hand them work', path: '/iq/local-compute',                         tenant: 'orgiq',  group: 'Build' },
  { label: 'Distillation overview',    hint: 'Tier health, ingest, sampling', path: '/iq/distillation/overview',                   tenant: 'orgiq',  group: 'Build' },
  { label: 'Distillation tiers',       hint: 'L0 observations · L1 clusters · L2 artifacts', path: '/iq/distillation/tiers',       tenant: 'orgiq',  group: 'Build' },
  { label: 'Distillation artifacts',   hint: 'L2 runbooks, insights, conventions', path: '/iq/distillation/artifacts',            tenant: 'orgiq',  group: 'Build' },
  { label: 'Distillation lineage',     hint: 'Observation → cluster → artifact → library', path: '/iq/distillation/lineage',      tenant: 'orgiq',  group: 'Build' },
  { label: 'Distillation compactions', hint: 'Job history + Compact L0→L1 / L1→L2', path: '/iq/distillation/compactions',         tenant: 'orgiq',  group: 'Build' },
  { label: 'Distillation review',      hint: 'Human sample queue + calibration', path: '/iq/distillation/review',                 tenant: 'orgiq',  group: 'Build' },
  // ── Org — organizational intelligence ──
  { label: 'Ask',                hint: 'Ask the org-search agent',            path: '/iq/invoke',                                  tenant: 'orgiq',  group: 'Org' },
  { label: 'Explore',            hint: 'Force-directed org graph',            path: '/iq/explore',                                 tenant: 'orgiq',  group: 'Org' },
  { label: 'Scores',             hint: 'Per-person influence leaderboard',    path: '/iq/scores',                                  tenant: 'orgiq',  group: 'Org', roles: PLATFORM },
  { label: 'Score cohorts',      hint: 'Scores grouped by team',              path: '/iq/scores/cohorts',                          tenant: 'orgiq',  group: 'Org', roles: PLATFORM },
  { label: 'Score compare',      hint: 'Radar overlay of people',             path: '/iq/scores/compare',                          tenant: 'orgiq',  group: 'Org', roles: PLATFORM },
  // ── Operate — prompts, health, platform ──
  { label: 'What is deployed',   hint: 'Live prompts + what to do next',      path: '/iq/prompt-ops',                              tenant: 'orgiq',  group: 'Design',  roles: PLATFORM },
  { label: 'Studio',             hint: 'Author, type the contract, test',     path: '/iq/prompts',                                 tenant: 'admin',  group: 'Design',  roles: PLATFORM },
  { label: 'Versions',           hint: 'Version log, diffs, past experiments', path: '/iq/history',                                 tenant: 'admin',  group: 'Design',  roles: PLATFORM },
  { label: 'Rollout',            hint: 'Canary A/B, weights, rollback',       path: '/iq/canary',                                  tenant: 'orgiq',  group: 'Design',  roles: PLATFORM },
  { label: 'Evals',              hint: 'Judge configuration + pass rates',    path: '/iq/evaluations',                             tenant: 'admin',  group: 'Design',  roles: PLATFORM },
  { label: 'Health',             hint: 'What is deployed, whether it works, what needs you', path: '/admin/observability/summary', tenant: 'admin', group: 'Operate', roles: PLATFORM },
  { label: 'On-Call',            hint: 'Live alarms + incident timeline',     path: '/admin/observability/oncall',                 tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Runs',               hint: 'Last 50 agent calls',                 path: '/admin/observability/invocations',            tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Architecture',       hint: 'The agent fleet and how it connects', path: '/iq/agents',                                  tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Knowledge',          hint: 'Sources, ingestion, and the knowledge bases agents retrieve from', path: '/admin/knowledge', tenant: 'admin', group: 'Operate', roles: PLATFORM },
  { label: 'Ingest sources',     hint: 'What content is pulled in',           path: '/admin/ingest/crawl',                         tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'Ingest runs',        hint: 'What each pull did',                  path: '/admin/ingest/history',                       tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'Ingest storage',     hint: 'Where documents land',                path: '/admin/ingest/storage',                       tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'KB sync',            hint: 'Storage → knowledge base',            path: '/admin/ingest/sources',                       tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'Ingest schedule',    hint: 'How often it re-syncs',               path: '/admin/ingest/schedules',                     tenant: 'admin',  group: 'Operate', roles: BUILD },
  { label: 'Capabilities',       hint: 'Guardrails, browser, interpreter',    path: '/admin/capabilities',                         tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Traffic',            hint: 'RPS + heatmap + top users',           path: '/admin/observability/traffic',                tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Invocations Search', hint: 'Triage by prompt / agent / score',    path: '/admin/observability/invocations/search',     tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Capability Events',  hint: 'Browser & code-interpreter events',   path: '/admin/observability/capability-events',      tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Tool Calls',         hint: 'Per-tool latency, volume, failures',  path: '/admin/observability/tools',                  tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Agent Metrics',      hint: 'Per-agent stats',                     path: '/admin/observability/agents',                 tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Sessions',           hint: 'Chat threads',                        path: '/admin/observability/sessions',               tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Authz Log',          hint: 'Live AVP / Cedar decisions',          path: '/admin/observability/authz',                  tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Memory',             hint: 'Memory ops + cold sessions',          path: '/admin/observability/memory',                 tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Guardrail Rules',    hint: 'Per-rule intervention details',       path: '/admin/observability/guardrail-rules',        tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Drift',              hint: 'Schema + judge + embedding drift',    path: '/admin/observability/drift',                  tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Quality',            hint: 'Judge scores + feedback',             path: '/admin/observability/quality',                tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Cost',               hint: 'Spend by agent + deploy markers',     path: '/admin/observability/cost',                   tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Approval Queue',     hint: 'Pending HITL decisions',              path: '/admin/observability/approvals',              tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Harness',            hint: 'Replay test set + view runs',         path: '/admin/observability/harness',                tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Calibration',        hint: 'Judge vs human MAE drift',            path: '/admin/observability/calibration',            tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  { label: 'Model Compare',      hint: 'Side-by-side run delta',              path: '/admin/observability/model-compare',          tenant: 'admin',  group: 'Operate', roles: PLATFORM },
  // ── System — administration ──
  { label: 'Identity',           hint: 'Users, roles, Cedar policies',        path: '/admin/identity',                             tenant: 'admin',  group: 'System',  roles: BUILD },
  { label: 'Policy sandbox',     hint: 'Dry-run an authz decision',           path: '/admin/identity/test',                        tenant: 'admin',  group: 'System',  roles: BUILD },
  { label: 'Settings',           hint: 'User preferences',                    path: '/settings',                                   tenant: 'universal', group: 'System' },
  // Assessment tenant — its own map (Assess / Analyze / Informatics / System),
  // mirroring NAV_ITEMS in Layout.tsx. Without these an assessment session's
  // palette listed nothing but Settings.
  { label: 'Dashboard',          hint: 'Cohorts, teams, scorecards',          path: '/assessment/teams',                           tenant: 'assessment', group: 'Assess' },
  { label: 'Submissions',        hint: 'Forms intake wizard',                 path: '/assessment/submissions',                     tenant: 'assessment', group: 'Assess' },
  { label: 'Reports',            hint: 'Program rollup, where to start',      path: '/assessment/reports',                         tenant: 'assessment', group: 'Analyze' },
  { label: 'Feedback',           hint: 'Open follow-ups across teams',        path: '/assessment/feedback',                        tenant: 'assessment', group: 'Analyze' },
  { label: 'Enterprise',         hint: 'Governance context',                  path: '/assessment/enterprise',                      tenant: 'assessment', group: 'Informatics' },
  { label: 'Workspace',          hint: 'Document explorer',                   path: '/assessment/workspace',                       tenant: 'assessment', group: 'Informatics' },
  { label: 'Prompts',            hint: 'Agent slash commands',                path: '/assessment/prompts',                         tenant: 'assessment', group: 'Informatics' },
  { label: 'Rules',              hint: 'Scoring stance + archetypes',         path: '/assessment/rules',                           tenant: 'assessment', group: 'Informatics' },
  { label: 'Activity',           hint: 'Agent run ledger',                    path: '/assessment/runs',                            tenant: 'assessment', group: 'System' },
  { label: 'Configuration',      hint: 'Motions, cohorts, target level',      path: '/assessment/configuration',                   tenant: 'assessment', group: 'System', roles: ['program-lead'] },
];

const UUID_RE = /^[0-9a-f-]{36}$/i;

function isPageVisible(page: PageEntry, tenant: string, role: string): boolean {
  if (page.tenant === 'universal') return true;
  // Platform pages (tenant 'admin') are org-tenant surfaces — same scoping as
  // the rail: a session parked on another tenant doesn't get org platform jumps.
  if (page.tenant === 'admin') {
    if (tenant !== 'orgiq') return false;
    if (role === 'admin') return true;
    return !page.roles || page.roles.includes(role);
  }
  if (page.tenant !== tenant) return false;
  if (role === 'admin') return true;
  return !page.roles || page.roles.includes(role);
}

// Recent harness runs for the palette's "Recent runs" group. The endpoint is
// an orgiq observability surface: from any other tenant it 403s, and the
// old hook refetched on every remount (its "loaded" flag was component
// state), so an assessment session logged a 403 on every navigation. Now
// gated on the tenant and cached at module level — one fetch per session
// per tenant, shared by every palette instance.
let harnessRunsCache: { tenant: string; runs: RecentRun[]; promise: Promise<RecentRun[]> | null } | null = null;

function fetchRecentHarnessRuns(tenant: string | null, role: string | null): Promise<RecentRun[]> {
  // Null = the session hasn't resolved yet. Defaulting that to orgiq is how
  // an assessment tab still fired (and 403'd) this request once per load.
  // The harness is a platform surface: a member could see real run rows in
  // the palette and be bounced away on selecting one (member audit #7).
  if (tenant !== 'orgiq') return Promise.resolve([]);
  if (role !== 'admin' && !PLATFORM.includes(role ?? '')) return Promise.resolve([]);
  if (harnessRunsCache?.tenant === tenant) {
    return harnessRunsCache.promise ?? Promise.resolve(harnessRunsCache.runs);
  }
  const entry = { tenant, runs: [] as RecentRun[], promise: null as Promise<RecentRun[]> | null };
  harnessRunsCache = entry;
  entry.promise = fetch('/api/observability/harness/runs?limit=5', { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      const raw = j == null ? [] : Array.isArray(j) ? j : ((j as { runs?: unknown }).runs ?? []);
      const list = Array.isArray(raw) ? (raw as RecentRun[]) : [];
      entry.runs = list.slice(0, 5);
      return entry.runs;
    })
    .catch(() => entry.runs)
    .finally(() => { entry.promise = null; });
  return entry.promise;
}

/** Test seam: forget the cached runs (a sign-out / tenant switch hard-navigates anyway). */
export function resetRecentHarnessRunsCache(): void { harnessRunsCache = null; }

function useRecentHarnessRuns(tenant: string | null, role: string | null): RecentRun[] {
  const [runs, setRuns] = useState<RecentRun[]>(() => (harnessRunsCache?.tenant === tenant ? harnessRunsCache.runs : []));

  useEffect(() => {
    let cancelled = false;
    void fetchRecentHarnessRuns(tenant, role).then((list) => { if (!cancelled) setRuns(list); });
    return () => { cancelled = true; };
  }, [tenant, role]);

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
  const runs = useRecentHarnessRuns(session?.tenant ?? null, session?.role ?? null);

  return useMemo<Command[]>(() => {
    // Stable sort: the tenant's rail order between groups, definition order
    // within one — so the palette never leads with Settings.
    const pageCommands: Command[] = PAGES
      .filter((p) => isPageVisible(p, tenant, role))
      .sort((a, b) => groupRank(tenant, a.group) - groupRank(tenant, b.group))
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
  // Optional: the palette is mounted inside ComputeHost, but a test or a
  // story may render the shell without it, and losing the terminal commands is
  // better than throwing on a missing provider.
  const compute = useComputeOptional();
  const boxes = compute?.computers ?? [];

  return useCallback((query: string): Command[] => {
    const q = query.trim();

    // Terminals from anywhere. The dock has hotkeys, but a hotkey cannot open
    // the FIRST shell — you have to pick a box — and the palette is where this
    // app already puts "do a thing without navigating".
    const wantsShell = /^(term|shell|tty|ssh|console)/i.test(q);
    if (wantsShell || q === '') {
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
  }, [navigate, boxes]);
}
