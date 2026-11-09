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
const PIPELINES_GROUPS: Record<string, string> = { queues: 'Runs',
  definitions: 'Catalog', runbooks: 'Catalog', runs: 'Runs', approvals: 'Runs', artifacts: 'Runs',
  decks: 'Runs', activity: 'Runs', communication: 'Runs', agents: 'Sources', bots: 'Sources', commands: 'Sources', configuration: 'System', settings: 'System', logging: 'System',
};
const PIPELINES_LABELS: Record<string, string> = { queues: 'Queues',
  definitions: 'Definitions', runbooks: 'Runbooks', runs: 'Runs', approvals: 'Approvals', artifacts: 'Artifacts', decks: 'Run reports', activity: 'Work graph', communication: 'Communication',
  agents: 'Agents', bots: 'Bots', commands: 'Commands', configuration: 'Configuration', settings: 'Pipeline settings', logging: 'Logging',
};
// The access tenant's rail (Layout.tsx NAV_ITEMS, docs/access-tenant-design.md §6).
const ACCESS_GROUPS: Record<string, string> = {
  catalog: 'Request', requests: 'Request', approvals: 'Approve',
  policies: 'Govern', reviews: 'Govern', audit: 'Govern', configuration: 'System', settings: 'System',
};
const ACCESS_LABELS: Record<string, string> = {
  catalog: 'Catalog', requests: 'Requests', approvals: 'Approvals', policies: 'Policies',
  reviews: 'Reviews', audit: 'Audit', configuration: 'Configuration', settings: 'Access settings',
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
function shortId(s: string): string {
  return s.length > 12 ? `${s.slice(0, 8)}…` : s;
}

export function resolveBreadcrumbs(pathname: string): Crumb[] {
  // Decoded: a record id with a reserved character arrives encoded in the
  // path (`/iq/runs/agent-run%3A79ee…`) while its page reads the decoded id
  // from the router and registers its title under that, so an encoded crumb
  // id never matched and the trail kept the raw id (walk, 9 November).
  const segs = pathname.split('/').filter(Boolean).map((seg) => { try { return decodeURIComponent(seg); } catch { return seg; } });
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
      case 'decisions':
        if (!b) return [{ label: 'Plan' }, { label: 'Decisions' }];
        return [{ label: 'Plan' }, { label: 'Decisions', path: '/iq/decisions' }, { label: shortId(b), id: b }];
      case 'designs':
        if (!b) return [{ label: 'Designs' }];
        return [{ label: 'Designs', path: '/iq/designs' }, { label: shortId(b), id: b }];
      case 'library':
        if (!b) return [{ label: 'Build' }, { label: 'Agent library' }];
        return [{ label: 'Build' }, { label: 'Agent library', path: '/iq/library' }, { label: shortId(b), id: b }];
      case 'promotions': return [{ label: 'Build' }, { label: 'Runbooks', path: '/iq/runbooks' }, { label: 'Proposals' }];
      case 'release': return [{ label: 'Build' }, { label: 'Local compute', path: '/iq/local-compute' }, { label: 'Configuration' }];
      case 'activity': return [{ label: 'Operate' }, { label: 'Work graph' }];
      // The rail's groups (Layout.tsx NAV_ITEMS): Runs under Operate,
      // Communication under Org. A document opens from Search; a status deck from its
      // initiative page.
      case 'runs':
        if (!b) return [{ label: 'Operate' }, { label: 'Runs' }];
        // Until the run page registers its title the crumb says what it is, not its id.
        return [{ label: 'Operate' }, { label: 'Runs', path: '/iq/runs' }, { label: 'Run', id: b }];
      case 'communication': return [{ label: 'Engage' }, { label: 'Communication' }];
      // Logging (G37): /iq/logging/<source>[/<kind>]/<id>; the record is the last segment.
      case 'logging': {
        const rec = segs.length > 3 ? segs[segs.length - 1] : undefined;
        if (!rec) return [{ label: 'System' }, { label: 'Logging' }];
        return [{ label: 'System' }, { label: 'Logging', path: '/iq/logging' }, { label: shortId(rec), id: rec }];
      }
      case 'documents':
        return [{ label: 'Engage' }, { label: 'Search', path: '/iq/search' }, ...(b ? [{ label: shortId(b), id: b }] : [])];
      case 'decks':
        return [{ label: 'Initiatives', path: '/iq/projects' }, ...(b ? [{ label: 'Deck', id: b }] : [])];
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
      // Runbooks: Library (the bare page and a runbook), Proposals, Briefs. The retired
      // /iq/distillation tree redirects before it renders.
      case 'runbooks': {
        const home = [{ label: 'Build' }, { label: 'Runbooks', path: '/iq/runbooks' }];
        if (b === 'proposals') return [...home, ...(c ? [{ label: 'Proposals', path: '/iq/runbooks/proposals' }, { label: shortId(c), id: c }] : [{ label: 'Proposals' }])];
        if (b === 'briefs') return [...home, ...(c ? [{ label: 'Briefs', path: '/iq/runbooks/briefs' }, { label: shortId(c), id: c }] : [{ label: 'Briefs' }])];
        if (!b) return [...home, { label: 'Library' }];
        return [...home, { label: 'Library', path: '/iq/runbooks' }, { label: shortId(b), id: b }];
      }
      case 'distillation': return [{ label: 'Build' }, { label: 'Runbooks', path: '/iq/runbooks' }];
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
        return [{ label: 'Build' }, { label: 'Automate' }, { label: 'Bots', path: '/admin/bots' }, { label: 'Bot', id: b }];
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
          ...(b && INGEST_LABELS[b]
            ? (c ? [{ label: INGEST_LABELS[b]!, path: `/admin/ingest/${b}` }, { label: shortId(c), id: c }] : [{ label: INGEST_LABELS[b]! }])
            : []),
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
        if (b === 'users' && c) return [{ label: 'System' }, { label: 'Identity', path: '/admin/identity' }, { label: 'Users', path: '/admin/identity/users' }, { label: shortId(c), id: c }];
        return [{ label: 'System' }, { label: 'Identity', path: '/admin/identity' }, { label: IDENTITY_LABELS[b] ?? b }];
      default: return [];
    }
  }

  if (root === 'assessment') {
    if (a === 'workspace') return [{ label: 'Workspace' }];
    if (a === 'decks') return [
      { label: 'Workspace', path: '/assessment/workspace?view=library' },
      { label: 'Presentations', path: '/assessment/workspace?view=presentations' },
      ...(b ? [{ label: 'Presentation', id: b }] : []),
    ];
    // Assess is the tenant's root context, already named by the shell.
    // Keep its trails to the collection and record; a page can add a third level.
    const page = a ?? 'teams';
    const group = ASSESSMENT_GROUPS[page] ?? 'Assessment';
    const trail: Crumb[] = group === 'Assess' ? [] : [{ label: group }];
    const pageLabel = ASSESSMENT_LABELS[page] ?? page;
    if (page === 'teams' && b) {
      return [...trail, { label: pageLabel, path: '/assessment/teams' }, { label: b, id: b }];
    }
    // A submission record: the page registers its team as the crumb's title.
    // A record opened beside its list rail: the page registers its title as the crumb's label.
    if ((page === 'submissions' || page === 'feedback' || page === 'runs') && b) {
      return [...trail, { label: pageLabel, path: `/assessment/${page}` }, { label: shortId(b), id: b }];
    }
    return [...trail, { label: pageLabel }];
  }

  // The social and pipelines tenants mirror their shell rails the same way:
  // the group the page sits under, then the page (Layout.tsx NAV_ITEMS).
  if (root === 'social') {
    const page = a ?? 'channels';
    if (b && page === 'contacts') return [{ label: SOCIAL_GROUPS[page] ?? 'Social' }, { label: SOCIAL_LABELS[page] ?? page, path: '/social/contacts' }, { label: shortId(b), id: b }];
    return [{ label: SOCIAL_GROUPS[page] ?? 'Social' }, { label: SOCIAL_LABELS[page] ?? page }];
  }
  if (root === 'pipelines') {
    const page = a ?? 'runs';
    const group = PIPELINES_GROUPS[page] ?? 'Pipelines';
    const label = PIPELINES_LABELS[page] ?? page;
    // The Runs page sits under the Runs group; name the product instead of "Runs › Runs".
    const trail: Crumb[] = [{ label: group === label ? 'Pipelines' : group }];
    if (b && page === 'runs') return [...trail, { label, path: '/pipelines/runs' }, { label: `Run ${shortId(b)}`, id: b }];
    // Logging (G37b): /pipelines/logging/<source>/<id>; the record is the last segment, as in orgiq.
    if (page === 'logging') {
      const rec = segs.length > 3 ? segs[segs.length - 1] : undefined;
      return rec ? [...trail, { label, path: '/pipelines/logging' }, { label: shortId(rec), id: rec }] : [...trail, { label }];
    }
    // Any other collection's record, opened beside its list rail; the page registers its title.
    if (b && (page === 'definitions' || page === 'approvals')) return [...trail, { label, path: `/pipelines/${page}` }, { label: shortId(b), id: b }];
    return [...trail, { label }];
  }

  if (root === 'access') {
    const page = a ?? 'requests';
    const trail: Crumb[] = [{ label: ACCESS_GROUPS[page] ?? 'Access' }];
    const label = ACCESS_LABELS[page] ?? page;
    if (page === 'requests' && b === 'new') return [...trail, { label, path: '/access/requests' }, { label: 'New request' }];
    if (page === 'requests' && b) return [...trail, { label, path: '/access/requests' }, { label: `Request ${b}`, id: b }];
    // Any other collection's record beside its list rail; the page registers its title.
    // The review record names its campaign the same way (ReviewRecordPage
    // registers `<id> · <title>`); without this its trail stopped at "Reviews".
    if (b && (page === 'policies' || page === 'reviews')) return [...trail, { label, path: `/access/${page}` }, { label: shortId(b), id: b }];
    return [...trail, { label }];
  }

  if (root === 'settings') return [{ label: 'System' }, { label: 'Settings' }];
  return [];
}
