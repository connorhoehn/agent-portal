// The pure half of the shell's breadcrumb trail: pathname → crumbs. Kept
// free of React so `__tests__/breadcrumbResolve.test.ts` can assert every
// rail path resolves to a trail — a route with no case here silently renders
// no trail at all (Library and Promotions shipped that way).
/** 'p-design-system-api' → 'Design System Api' — readable without a fetch. */
function initiativeName(id: string): string {
  return id.replace(/^p-/, '').split('-')
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w)).join(' ') || id;
}

export interface Crumb {
  label: string;
  path?: string;
}

const OBS_LABELS: Record<string, string> = {
  oncall: 'On-Call', 'capability-events': 'Capability Events', agents: 'Agent Metrics',
  sessions: 'Sessions', authz: 'Authz Log', drift: 'Drift', quality: 'Quality',
  cost: 'Cost', calibration: 'Calibration', 'model-compare': 'Model Compare',
  memory: 'Memory', 'guardrail-rules': 'Guardrail Rules', traffic: 'Traffic',
  tools: 'Tool Calls',
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
/** Which shell-rail group each assessment page hangs under — kept in step
 *  with NAV_ITEMS in Layout.tsx. */
const ASSESSMENT_GROUPS: Record<string, string> = {
  teams: 'Assess', submissions: 'Assess',
  reports: 'Analyze', feedback: 'Analyze',
  enterprise: 'Informatics', workspace: 'Informatics', prompts: 'Informatics', rules: 'Informatics',
  runs: 'System', configuration: 'System',
};
const ASSESSMENT_LABELS: Record<string, string> = {
  teams: 'Dashboard', submissions: 'Submissions', feedback: 'Feedback', reports: 'Reports',
  enterprise: 'Enterprise', workspace: 'Workspace', prompts: 'Prompts', rules: 'Rules',
  runs: 'Activity', configuration: 'Configuration',
};
const PROMPT_PAGES: Record<string, string> = {
  prompts: 'Prompt Studio', canary: 'Deployment', history: 'History',
  diff: 'Diff', evaluations: 'Evaluations',
};
const DISTILLATION_LABELS: Record<string, string> = {
  overview: 'Overview', tiers: 'Tiers', artifacts: 'Artifacts',
  lineage: 'Lineage', compactions: 'Compactions', review: 'Review sample',
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
        if (!b) return [{ label: 'Build' }, { label: 'Automate' }];
        if (b === 'changes') return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: 'Graph updates' }];
        if (b === 'queue') return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: 'Queue' }];
        if (b === 'findings') return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: 'Findings' }];
        return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: `Job ${shortId(b)}` }];
      case 'projects':
        if (!b) return [{ label: 'Plan' }, { label: 'Initiatives' }];
        return [{ label: 'Plan' }, { label: 'Initiatives', path: '/iq/projects' }, { label: initiativeName(b) }];
      case 'designs':
        if (!b) return [{ label: 'Design' }, { label: 'Designs' }];
        return [{ label: 'Design' }, { label: 'Designs', path: '/iq/designs' }, { label: shortId(b) }];
      case 'library':
        if (!b) return [{ label: 'Design' }, { label: 'Library' }];
        return [{ label: 'Design' }, { label: 'Library', path: '/iq/library' }, { label: shortId(b) }];
      case 'promotions': return [{ label: 'Design' }, { label: 'Promotions' }];
      case 'release': return [{ label: 'Release' }, { label: 'Session config' }];
      case 'sprints': return [{ label: 'Plan' }, { label: 'Initiatives', path: '/iq/projects' }, { label: 'Sprints' }];
      case 'invoke': return [{ label: 'Org' }, { label: 'Ask' }];
      case 'explore': return [{ label: 'Org' }, { label: 'Explore' }];
      case 'scores':
        if (!b) return [{ label: 'Org' }, { label: 'Scores' }];
        return [{ label: 'Org' }, { label: 'Scores', path: '/iq/scores' }, { label: b === 'cohorts' ? 'Cohorts' : 'Compare' }];
      case 'agents':
        if (!b) return [{ label: 'Operate' }, { label: 'Architecture' }];
        return [{ label: 'Operate' }, { label: 'Architecture', path: '/iq/agents' }, { label: b }];
      case 'prompt-ops': return [{ label: 'Operate' }, { label: 'Prompts' }];
      case 'distillation': {
        const page = b ?? 'overview';
        return [{ label: 'Build' }, { label: 'Distillation', path: '/iq/distillation' }, { label: DISTILLATION_LABELS[page] ?? page }];
      }
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
      case 'budgets': return [{ label: 'Plan' }, { label: 'Budgets' }];
      case 'bots':
        if (!b) return [{ label: 'Build' }, { label: 'Automate' }, { label: 'Bots' }];
        return [{ label: 'Build' }, { label: 'Automate' }, { label: 'Bots', path: '/admin/bots' }, { label: `Bot ${shortId(b)}` }];
      case 'changes': return [{ label: 'Build' }, { label: 'Automate' }, { label: 'Changes' }];
      case 'devbox': return [{ label: 'Build' }, { label: 'Computer Lab' }];
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

  if (root === 'assessment') {
    // Mirrors the shell rail for this tenant (Layout.tsx NAV_ITEMS): the first
    // crumb is the GROUP the page sits under, the second the page — the same
    // shape as `Plan › Initiatives › Observability` in the org tenant, so a
    // person reads where they are the same way in both products.
    const page = a ?? 'teams';
    const group = ASSESSMENT_GROUPS[page] ?? 'Assessment';
    const pageLabel = ASSESSMENT_LABELS[page] ?? page;
    if (page === 'teams' && b) {
      return [{ label: group }, { label: pageLabel, path: '/assessment/teams' }, { label: b }];
    }
    return [{ label: group }, { label: pageLabel }];
  }

  if (root === 'settings') return [{ label: 'System' }, { label: 'Settings' }];
  return [];
}
