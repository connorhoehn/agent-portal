// Breadcrumb trail for deep pages. Two stacked rails tell you what you CAN
// open, not where you ARE — three levels in (/admin/ingest/history) nothing on
// screen said "this is Knowledge → Pipeline → Runs". The trail is derived from
// the route in one place, so every page gets it without per-page wiring, and it
// only renders at 3+ levels — on shallow pages the rail already is the answer.
//
// Group crumbs (Build/Org/Operate/System) are context, not destinations —
// they render unlinked. Everything else links except the current page.

import { useMemo } from 'react';
import { Link, useLocation } from 'react-router';

export interface Crumb {
  label: string;
  path?: string;
}

const OBS_LABELS: Record<string, string> = {
  oncall: 'On-Call', 'capability-events': 'Capability Events', agents: 'Agent Metrics',
  sessions: 'Sessions', authz: 'Authz Log', drift: 'Drift', quality: 'Quality',
  cost: 'Cost', calibration: 'Calibration', 'model-compare': 'Model Compare',
  memory: 'Memory', 'guardrail-rules': 'Guardrail Rules', traffic: 'Traffic',
  approvals: 'Approvals',
};
const INGEST_LABELS: Record<string, string> = {
  crawl: 'Sources', history: 'Runs', storage: 'Storage', sources: 'KB sync', schedules: 'Schedule',
};
const IDENTITY_LABELS: Record<string, string> = {
  users: 'Users', roles: 'Roles', policies: 'Policies', schema: 'Schema', test: 'Sandbox',
};
const CAPABILITY_LABELS: Record<string, string> = {
  guardrails: 'Guardrails', 'code-interpreter': 'Code Interpreter', browser: 'Browser',
};
const NEWSROOM_LABELS: Record<string, string> = {
  articles: 'Articles', beats: 'Beat coverage', researcher: 'Researcher',
  briefs: 'Briefs', headlines: 'Headlines', pitches: 'Pitches',
};
const PROMPT_PAGES: Record<string, string> = {
  prompts: 'Prompt Studio', canary: 'Deployment', history: 'History',
  diff: 'Diff', evaluations: 'Evaluations',
};

function shortId(s: string): string {
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
}

export function resolveBreadcrumbs(pathname: string): Crumb[] {
  const segs = pathname.split('/').filter(Boolean);
  const [root, a, b, c, d] = segs;

  if (root === 'iq') {
    switch (a) {
      case 'work':
        if (!b) return [{ label: 'Build' }, { label: 'Work' }];
        if (b === 'changes') return [{ label: 'Build' }, { label: 'Work', path: '/iq/work' }, { label: 'Graph updates' }];
        return [{ label: 'Build' }, { label: 'Work', path: '/iq/work' }, { label: `Job ${shortId(b)}` }];
      case 'projects':
        if (!b) return [{ label: 'Build' }, { label: 'Initiatives' }];
        return [{ label: 'Build' }, { label: 'Initiatives', path: '/iq/projects' }, { label: 'Detail' }];
      case 'invoke': return [{ label: 'Org' }, { label: 'Ask' }];
      case 'explore': return [{ label: 'Org' }, { label: 'Explore' }];
      case 'scores':
        if (!b) return [{ label: 'Org' }, { label: 'Scores' }];
        return [{ label: 'Org' }, { label: 'Scores', path: '/iq/scores' }, { label: b === 'cohorts' ? 'Cohorts' : 'Compare' }];
      case 'agents':
        if (!b) return [{ label: 'Operate' }, { label: 'Architecture' }];
        return [{ label: 'Operate' }, { label: 'Architecture', path: '/iq/agents' }, { label: b }];
      case 'prompt-ops': return [{ label: 'Operate' }, { label: 'Prompts' }];
      default:
        if (a && PROMPT_PAGES[a]) {
          return [{ label: 'Operate' }, { label: 'Prompts', path: '/iq/prompt-ops' }, { label: PROMPT_PAGES[a] }];
        }
        return [];
    }
  }

  if (root === 'admin') {
    switch (a) {
      case 'projects': return [{ label: 'Build' }, { label: 'Codebases' }];
      case 'changes': return [{ label: 'Build' }, { label: 'Changes' }];
      case 'devbox': return [{ label: 'Build' }, { label: 'Computers' }];
      case 'knowledge':
        if (!b) return [{ label: 'Operate' }, { label: 'Knowledge' }];
        if (b === 'registry' && c) {
          return [
            { label: 'Operate' }, { label: 'Knowledge', path: '/admin/knowledge' },
            { label: 'Registry', path: '/admin/knowledge/registry' }, { label: shortId(c) },
          ];
        }
        return [{ label: 'Operate' }, { label: 'Knowledge', path: '/admin/knowledge' }, { label: 'Registry' }];
      case 'ingest':
        return [
          { label: 'Operate' }, { label: 'Knowledge', path: '/admin/knowledge' }, { label: 'Pipeline' },
          ...(b && INGEST_LABELS[b] ? [{ label: INGEST_LABELS[b]! }] : []),
        ];
      case 'observability': {
        if (!b || b === 'summary') return [{ label: 'Operate' }, { label: 'Health' }];
        const base: Crumb[] = [{ label: 'Operate' }, { label: 'Health', path: '/admin/observability/summary' }];
        if (b === 'invocations') {
          if (!c) return [...base, { label: 'Runs' }];
          if (c === 'search') return [...base, { label: 'Runs', path: '/admin/observability/invocations' }, { label: 'Search' }];
          return [...base, { label: 'Runs', path: '/admin/observability/invocations' }, { label: `Invocation ${shortId(c)}` }];
        }
        if (b === 'harness') {
          if (!c) return [...base, { label: 'Harness' }];
          const harness: Crumb[] = [...base, { label: 'Harness', path: '/admin/observability/harness' }];
          if (c === 'runs' && d) return [...harness, { label: `Run ${shortId(d)}` }];
          if (c === 'compare') return [...harness, { label: 'Compare runs' }];
          return harness;
        }
        return [...base, { label: OBS_LABELS[b] ?? b }];
      }
      case 'capabilities':
        if (!b) return [{ label: 'Operate' }, { label: 'Capabilities' }];
        return [{ label: 'Operate' }, { label: 'Capabilities', path: '/admin/capabilities' }, { label: CAPABILITY_LABELS[b] ?? b }];
      case 'identity':
        if (!b) return [{ label: 'System' }, { label: 'Identity' }];
        return [{ label: 'System' }, { label: 'Identity', path: '/admin/identity' }, { label: IDENTITY_LABELS[b] ?? b }];
      default: return [];
    }
  }

  if (root === 'newsroom') {
    if (!a || a === 'home') return [{ label: 'Newsroom' }, { label: 'Home' }];
    const base: Crumb[] = [{ label: 'Newsroom', path: '/newsroom/home' }];
    if (a === 'articles' && b) return [...base, { label: 'Articles', path: '/newsroom/articles' }, { label: 'Article' }];
    if (a === 'entities' && b) return [...base, { label: 'Entities' }, { label: shortId(b) }];
    return [...base, { label: NEWSROOM_LABELS[a] ?? a }];
  }

  if (root === 'settings') return [{ label: 'System' }, { label: 'Settings' }];
  return [];
}

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const crumbs = useMemo(() => resolveBreadcrumbs(pathname), [pathname]);
  // Two levels is what the rail already shows; the trail earns its row at three.
  if (crumbs.length < 3) return null;
  return (
    <nav
      aria-label="Breadcrumb"
      className="shrink-0 flex items-center gap-1.5 px-4 py-1.5 border-b border-border bg-surface text-[11.5px] overflow-x-auto whitespace-nowrap"
    >
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1;
        return (
          <span key={`${crumb.label}-${i}`} className="flex items-center gap-1.5 min-w-0">
            {i > 0 && <span aria-hidden="true" className="text-text-tertiary">›</span>}
            {crumb.path && !last ? (
              <Link to={crumb.path} className="text-text-secondary no-underline hover:text-primary hover:underline">
                {crumb.label}
              </Link>
            ) : (
              <span className={last ? 'text-text-primary font-semibold' : 'text-text-tertiary'}>
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
