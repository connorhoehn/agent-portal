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
  /** The entity id behind a shortened label, so a mounted page can supply
   *  the real title through `lib/crumbLabels`. */
  id?: string;
}

const OBS_LABELS: Record<string, string> = {
  oncall: 'On-Call', 'capability-events': 'Capability Events', agents: 'Agent Metrics',
  sessions: 'Sessions', authz: 'Access log', drift: 'Drift', quality: 'Quality',
  cost: 'Cost', calibration: 'Calibration', 'model-compare': 'Model Compare',
  memory: 'Memory', 'guardrail-rules': 'Guardrails', traffic: 'Traffic',
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
const SOCIAL_GROUPS: Record<string, string> = {
  channels: 'Talk', dms: 'Talk', calls: 'Meet', rooms: 'Meet', contacts: 'People', teams: 'People',
  profile: 'People', recordings: 'Library', 'work-graph': 'Library', configuration: 'System', settings: 'System',
};
const SOCIAL_LABELS: Record<string, string> = {
  channels: 'Channels', dms: 'Direct messages', calls: 'Calls', rooms: 'Rooms', contacts: 'Contacts',
  teams: 'Teams', profile: 'Profile', recordings: 'Recordings', 'work-graph': 'Work graph', configuration: 'Configuration', settings: 'Social settings',
};
const PIPELINES_GROUPS: Record<string, string> = {
  definitions: 'Catalog', runbooks: 'Catalog', runs: 'Runs', approvals: 'Runs', artifacts: 'Runs',
  decks: 'Runs', activity: 'Runs', communication: 'Runs', agents: 'Sources', bots: 'Sources', commands: 'Sources', configuration: 'System', settings: 'System',
};
const PIPELINES_LABELS: Record<string, string> = {
  definitions: 'Definitions', runbooks: 'Runbooks', runs: 'Runs', approvals: 'Approvals', artifacts: 'Artifacts', decks: 'Run reports', activity: 'Work graph', communication: 'Communication',
  agents: 'Agents', bots: 'Bots', commands: 'Commands', configuration: 'Configuration', settings: 'Pipeline settings',
};
const ASSESSMENT_GROUPS: Record<string, string> = {
  teams: 'Assess', submissions: 'Assess', communication: 'Assess',
  reports: 'Analyze', decks: 'Analyze', activity: 'Analyze', feedback: 'Analyze',
  enterprise: 'Informatics', workspace: 'Informatics', prompts: 'Informatics', rules: 'Informatics',
  runs: 'System', configuration: 'System',
};
const ASSESSMENT_LABELS: Record<string, string> = {
  teams: 'Dashboard', submissions: 'Submissions', communication: 'Communication', feedback: 'Feedback', reports: 'Reports',
  enterprise: 'Enterprise', workspace: 'Workspace', prompts: 'Prompts', rules: 'Rules',
  runs: 'Activity', activity: 'Work graph', decks: 'Review decks', configuration: 'Configuration',
};
// The rail's own words (iqSubNavFormat.ts PROMPT_MGMT_ITEMS) — the name a
// person clicked is the name the trail should repeat.
const PROMPT_PAGES: Record<string, string> = {
  prompts: 'Studio', canary: 'Rollout', history: 'Versions',
  diff: 'Diff', evaluations: 'Evals',
};
// The module header prints the three tabs; the crumb names the one open.
// Legacy sub-paths redirect before they render, so they need no label.
const DISTILLATION_LABELS: Record<string, string> = {
  knowledge: 'Knowledge', review: 'Review', activity: 'Activity',
};

function shortId(s: string): string {
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
}

export function resolveBreadcrumbs(pathname: string): Crumb[] {
  const segs = pathname.split('/').filter(Boolean);
  const [root, a, b, c, d] = segs;

  if (root === 'iq') {
    switch (a) {
      case 'search': return [{ label: 'Engage' }, { label: 'Search' }];
      case 'work':
        if (!b) return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: 'Inbox' }];
        if (b === 'changes') return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: 'Changes' }];
        if (b === 'queue') return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: 'Runs' }];
        if (b === 'findings') return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: 'Findings' }];
        return [{ label: 'Build' }, { label: 'Automate', path: '/iq/work' }, { label: 'Runs', path: '/iq/work/queue' }, { label: `Run ${shortId(b)}`, id: b }];
      case 'projects':
        if (!b) return [{ label: 'Plan' }, { label: 'Initiatives' }];
        return [{ label: 'Plan' }, { label: 'Initiatives', path: '/iq/projects' }, { label: initiativeName(b) }];
      case 'designs':
        if (!b) return [{ label: 'Design' }, { label: 'Designs' }];
        return [{ label: 'Design' }, { label: 'Designs', path: '/iq/designs' }, { label: shortId(b), id: b }];
      case 'library':
        if (!b) return [{ label: 'Build' }, { label: 'Agent library' }];
        return [{ label: 'Build' }, { label: 'Agent library', path: '/iq/library' }, { label: shortId(b), id: b }];
      case 'promotions': return [{ label: 'Build' }, { label: 'Distillation', path: '/iq/distillation/knowledge' }, { label: 'Review', path: '/iq/distillation/review' }, { label: 'Asset promotions' }];
      case 'release': return [{ label: 'Build' }, { label: 'Local compute', path: '/iq/local-compute' }, { label: 'Configuration' }];
      case 'activity': return [{ label: 'Operate' }, { label: 'Work graph' }];
      // The rail's groups (Layout.tsx NAV_ITEMS): Runs under Operate,
      // Communication under Org. A document opens from Search; a status deck from its
      // initiative page.
      case 'runs':
        if (!b) return [{ label: 'Operate' }, { label: 'Runs' }];
        return [{ label: 'Operate' }, { label: 'Runs', path: '/iq/runs' }, { label: `Run ${shortId(b)}`, id: b }];
      case 'communication': return [{ label: 'Engage' }, { label: 'Communication' }];
      case 'documents':
        return [{ label: 'Engage' }, { label: 'Search', path: '/iq/search' }, ...(b ? [{ label: shortId(b), id: b }] : [])];
      case 'decks':
        return [{ label: 'Initiatives', path: '/iq/projects' }, ...(b ? [{ label: `Deck ${shortId(b)}`, id: b }] : [])];
      case 'sprints': return [{ label: 'Plan' }, { label: 'Initiatives', path: '/iq/projects' }, { label: 'Sprints' }];
      case 'invoke': return [{ label: 'Engage' }, { label: 'Ask' }];
      case 'explore': return [{ label: 'Engage' }, { label: 'Explore' }];
      case 'scores':
        if (!b) return [{ label: 'Engage' }, { label: 'Scores' }];
        return [{ label: 'Engage' }, { label: 'Scores', path: '/iq/scores' }, { label: b === 'cohorts' ? 'Cohorts' : 'Compare' }];
      case 'agents':
        if (!b) return [{ label: 'Operate' }, { label: 'Architecture' }];
        return [{ label: 'Operate' }, { label: 'Architecture', path: '/iq/agents' }, { label: b, id: b }];
      // Prompt management is the Library's rail (Design); the rail lights
      // Library on these pages, so the crumb says the same.
      case 'prompt-ops': return [{ label: 'Build' }, { label: 'Agent library', path: '/iq/library' }, { label: 'What is deployed' }];
      case 'distillation': {
        const page = b ?? 'knowledge';
        return [{ label: 'Build' }, { label: 'Distillation', path: '/iq/distillation/knowledge' }, { label: DISTILLATION_LABELS[page] ?? page }];
      }
      case 'local-compute': return b === 'configuration'
        ? [{ label: 'Build' }, { label: 'Local compute', path: '/iq/local-compute' }, { label: 'Configuration' }]
        : [{ label: 'Build' }, { label: 'Local compute' }];
      default:
        if (a && PROMPT_PAGES[a]) {
          return [{ label: 'Build' }, { label: 'Agent library', path: '/iq/library' }, { label: 'Prompts', path: '/iq/prompt-ops' }, { label: PROMPT_PAGES[a] }];
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
        return [{ label: 'Build' }, { label: 'Automate' }, { label: 'Bots', path: '/admin/bots' }, { label: `Bot ${shortId(b)}`, id: b }];
      case 'changes': return [{ label: 'Build' }, { label: 'Automate' }, { label: 'Changes' }];
      case 'devbox': return [{ label: 'Build' }, { label: 'Computer Lab' }];
      case 'knowledge':
        if (!b) return [{ label: 'Operate' }, { label: 'Knowledge' }];
        if (b === 'registry' && c) {
          return [
            { label: 'Operate' }, { label: 'Knowledge', path: '/admin/knowledge' },
            { label: 'Registry', path: '/admin/knowledge/registry' }, { label: shortId(c), id: c },
          ];
        }
        return [{ label: 'Operate' }, { label: 'Knowledge', path: '/admin/knowledge' }, { label: 'Registry' }];
      case 'ingest':
        return [
          { label: 'Operate' }, { label: 'Knowledge', path: '/admin/knowledge' }, { label: 'Pipeline' },
          ...(b && INGEST_LABELS[b] ? [{ label: INGEST_LABELS[b]! }] : []),
        ];
      case 'observability': {
        if (!b) return [{ label: 'Operate' }, { label: 'Observability' }];
        if (b === 'summary') return [{ label: 'Operate' }, { label: 'Observability', path: '/admin/observability/summary' }, { label: 'Overview' }];
        const base: Crumb[] = [{ label: 'Operate' }, { label: 'Observability', path: '/admin/observability/summary' }];
        if (b === 'invocations') {
          if (!c) return [...base, { label: 'Runs' }];
          if (c === 'search') return [...base, { label: 'Runs', path: '/admin/observability/invocations' }, { label: 'Search' }];
          return [...base, { label: 'Runs', path: '/admin/observability/invocations' }, { label: `Invocation ${shortId(c)}`, id: c }];
        }
        if (b === 'harness') {
          if (!c) return [...base, { label: 'Harness' }];
          const harness: Crumb[] = [...base, { label: 'Harness', path: '/admin/observability/harness' }];
          if (c === 'runs' && d) return [...harness, { label: `Run ${shortId(d)}`, id: d }];
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
    if (a === 'workspace') return [{ label: 'Workspace' }];
    if (a === 'decks') return [
      { label: 'Workspace', path: '/assessment/workspace?view=library' },
      { label: 'Presentations', path: '/assessment/workspace?view=presentations' },
      ...(b ? [{ label: `Presentation ${shortId(b)}`, id: b }] : []),
    ];
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

  // The social and pipelines tenants mirror their shell rails the same way:
  // the group the page sits under, then the page (Layout.tsx NAV_ITEMS).
  if (root === 'social') {
    const page = a ?? 'channels';
    return [{ label: SOCIAL_GROUPS[page] ?? 'Social' }, { label: SOCIAL_LABELS[page] ?? page }];
  }
  if (root === 'pipelines') {
    const page = a ?? 'runs';
    const group = PIPELINES_GROUPS[page] ?? 'Pipelines';
    const label = PIPELINES_LABELS[page] ?? page;
    // The Runs page sits under the Runs group; name the product instead of "Runs › Runs".
    const trail: Crumb[] = [{ label: group === label ? 'Pipelines' : group }];
    if (b && page === 'runs') return [...trail, { label, path: '/pipelines/runs' }, { label: `Run ${shortId(b)}`, id: b }];
    return [...trail, { label }];
  }

  if (root === 'settings') return [{ label: 'System' }, { label: 'Settings' }];
  return [];
}
