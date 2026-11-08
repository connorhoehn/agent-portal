// The voice navigator's kind tables (catalogue v2, docs/voice-tool-inventory.md
// §2 and §3, package V2-5): one table per tenant naming every kind of record
// `list` and `get` read, the route each reads (the same GET the kind's page
// makes, behind the same gate), the filters the route takes, and how a row is
// shaped to the four things the model hears (title, subtitle, status, when)
// plus the ref it can hand back and the portal page it opens on.
//
// Rules this encodes:
// - every route here is a `read` in docs/voice-tool-inventory.json (the table
//   test, __tests__/kinds.test.ts); nothing here writes;
// - the gate is the page's: `action` checked with can(), or the route's read
//   tier (`readRoles`) before it; Social kinds need the Social grant (the
//   plane outside the Social tenant);
// - a row is a typed ref `kind:id`; the model never passes a path, and the
//   href is built here from the id, never taken from the model;
// - shaping keeps scalar fields only, never a body, a prompt, a
//   justification, an address, a secret or a money figure (money is `budget`'s).
//
// No React and only type imports, so `node --test` loads it.

import type { Action } from '../capabilities';

export type Rec = Record<string, unknown>;
/** A field: one dotted path, the first present of several, or a function of the row. */
export type Field = string | readonly string[] | ((row: Rec) => unknown);

export interface PartSpec {
  /** The route (`:id` is the record's id); absent = a key of the record's own detail body. */
  path?: string;
  /** The array's key in the body (default: the first array found). */
  key?: string;
  /** The kind its rows are, so they carry refs (and hrefs) of their own. */
  kind?: string;
  /** How a row is named, where the defaults miss (a review item names its person). */
  title?: Field;
  subtitle?: Field;
  status?: Field;
}

export interface KindSpec {
  kind: string;
  /** What the kind is called in speech, plural ("initiatives"). */
  label: string;
  /** One of them, where dropping the s does not say it ("person"). */
  one?: string;
  list?: {
    path: string;
    /** The array's key in the body (default: the body itself, else its first array). */
    key?: string;
    /** Query parameters always sent. */
    params?: Readonly<Record<string, string>>;
    /** filter.<name> sent as this query parameter; a filter not named here is applied to the shaped rows. */
    filters?: Readonly<Partial<Record<'q' | 'status' | 'scope', string>>>;
    /** The scopes the route takes (filter.scope), the first being the default. */
    scopes?: readonly string[];
  };
  get?: {
    path: string;
    /** The record's key in the body (default: the body itself). */
    record?: string;
  };
  parts?: Readonly<Record<string, PartSpec>>;
  /** can() on this action, unless the role is in readRoles (the route's read tier). */
  action?: Action;
  readRoles?: readonly string[];
  /** get's own action where it differs from the list's (a person's graph detail: ViewOrgChart). */
  getAction?: Action;
  /** A Social kind: ViewSocial in Social, the plane's grant elsewhere. */
  social?: boolean;
  id?: Field;
  title?: Field;
  subtitle?: Field;
  status?: Field;
  at?: Field;
  /** The portal page a row opens on; undefined = none. */
  href?: (id: string, row: Rec) => string | undefined;
}

// ── shaping ─────────────────────────────────────────────────────────────────

const DEFAULTS: Readonly<Record<'id' | 'title' | 'subtitle' | 'status' | 'at', readonly string[]>> = {
  id: ['id', 'slug', 'teamId', 'roomId', 'task_id', 'recordingId', 'callId', 'userId', 'jobId', 'channel'],
  title: ['title', 'name', 'topic', 'displayName', 'label', 'subject', 'question', 'command', 'repoFullName', 'item.title'],
  subtitle: ['subtitle', 'ownerName', 'orgProjectName', 'assigneeName', 'cohort_label', 'severity', 'requester.displayName'],
  status: ['status', 'state', 'stage', 'outcome', 'lifecycleStatus'],
  at: ['updatedAt', 'updated_at', 'lastActivityAt', 'lastMessageAt', 'lastActiveAt', 'startedAt', 'started_at', 'submittedAt', 'createdAt', 'created_at', 'at'],
};

function dig(row: Rec, path: string): unknown {
  let v: unknown = row;
  for (const k of path.split('.')) {
    if (!v || typeof v !== 'object') return undefined;
    v = (v as Rec)[k];
  }
  return v;
}

function pick(row: Rec, field: Field | undefined, fallback: readonly string[]): string | undefined {
  const tryPath = (p: string) => {
    const v = dig(row, p);
    return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
  };
  if (typeof field === 'function') {
    const v = field(row);
    return typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : undefined;
  }
  for (const p of typeof field === 'string' ? [field] : field ?? fallback) {
    const v = tryPath(p);
    if (v) return v;
  }
  return undefined;
}

/** The array a list or part read answered: the body itself, the named key, else the body's first array. */
export function collectionOf(body: unknown, key?: string): Rec[] {
  if (Array.isArray(body)) return body.filter((r): r is Rec => !!r && typeof r === 'object');
  if (!body || typeof body !== 'object') return [];
  const b = body as Rec;
  const arr = key ? b[key] : Object.values(b).find(Array.isArray);
  return Array.isArray(arr) ? arr.filter((r): r is Rec => !!r && typeof r === 'object') : [];
}

export interface ShapedRow { id: string; title: string; subtitle?: string; status?: string; at?: string; href?: string; raw: Rec }

export function shapeRow(spec: Pick<KindSpec, 'id' | 'title' | 'subtitle' | 'status' | 'at' | 'href'>, raw: Rec): ShapedRow | null {
  const id = pick(raw, spec.id, DEFAULTS.id);
  if (!id) return null;
  const title = pick(raw, spec.title, DEFAULTS.title) ?? id;
  const subtitle = pick(raw, spec.subtitle, DEFAULTS.subtitle);
  const status = pick(raw, spec.status, DEFAULTS.status);
  const at = pick(raw, spec.at, DEFAULTS.at);
  const href = spec.href?.(id, raw);
  return { id, title, ...(subtitle && subtitle !== title ? { subtitle } : {}), ...(status ? { status } : {}), ...(at ? { at } : {}), ...(href ? { href } : {}), raw };
}

/** Field names never told to the model: ids it gets as the ref, links, bodies, money, secrets and addresses. */
const WITHHELD = /(^id$|Id$|_id$|Ids$|^ids$|href|url|uri|arn|account|avatar|usd|cost|price|amount|budget|spend|justification|payload|prompt|template|instructions|token|secret|password|email|phone|^body$|content|markdown|diff|^doc$|context|transcript|^text$|sql|^key$|checksum|sha)/i;
const MAX_FACTS = 8;

/** A record's own scalar fields (and how many items each list holds), minus what WITHHELD names. */
export function factsOf(record: Rec, used: ReadonlySet<string>): Rec {
  const facts: Rec = {};
  let n = 0;
  for (const [k, v] of Object.entries(record)) {
    if (n >= MAX_FACTS) break;
    if (used.has(k) || WITHHELD.test(k)) continue;
    if (typeof v === 'string' && v.trim()) { facts[k] = v; n++; }
    else if (typeof v === 'number' || typeof v === 'boolean') { facts[k] = v; n++; }
    else if (Array.isArray(v) && v.length) { facts[`${k}Count`] = v.length; n++; }
  }
  return facts;
}

/** The record a get read answered: the named key, else the body. */
export function recordOf(body: unknown, key?: string): Rec | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Rec;
  const r = key ? b[key] : b;
  return r && typeof r === 'object' && !Array.isArray(r) ? r as Rec : null;
}

/** A route template with the record's id in it. */
export const fill = (path: string, id: string): string => path.replace(/:[A-Za-z]+/, encodeURIComponent(id));

/** `kind:id` split at the first colon (ids may hold colons: `run:agent-run:…`). */
export function parseRef(ref: string): { kind: string; id: string } | null {
  const i = ref.indexOf(':');
  if (i < 1 || i === ref.length - 1) return null;
  return { kind: ref.slice(0, i), id: ref.slice(i + 1) };
}

// ── the tables ──────────────────────────────────────────────────────────────

const enc = encodeURIComponent;
/** The routes' read tiers (index.ts readForRolesElseAction), with the cross-tenant admin. */
const RUN_READERS = ['org-leader', 'hr-admin', 'program-owner', 'admin'];
const FLEET_READERS = ['org-leader', 'hr-admin', 'program-owner', 'admin'];
const ENV_READERS = ['member', 'sme', 'org-leader', 'hr-admin', 'admin'];
const CODEBASE_READERS = ['org-leader', 'hr-admin', 'admin'];

const peersOf = (row: Rec) => {
  const peers = Array.isArray(row['peers']) ? row['peers'] as Rec[] : [];
  return peers.map((p) => p['displayName']).filter((n) => typeof n === 'string').join(', ') || undefined;
};

/** The Social kinds, on Social's own routes or the plane's (`/api/social/plane`), opening in that tenant's Communication pages. */
function socialKinds(api: string, pages: string, inSocial: boolean, teamKind = 'team'): KindSpec[] {
  return [
    {
      kind: 'channel', label: 'channels', social: true,
      list: { path: `${api}/channels` },
      ...(inSocial ? { get: { path: `${api}/channels/:slug`, record: 'channel' }, parts: { members: { key: 'members', kind: 'person' }, recent: { key: 'recent' } } } : {}),
      id: 'slug', subtitle: 'lastMessagePreview', at: ['lastMessageAt', 'createdAt'],
      href: (id) => `${pages}/channels/${enc(id)}`,
    },
    {
      kind: teamKind, label: teamKind === 'team' ? 'teams' : 'Social teams', social: true,
      list: { path: `${api}/teams` }, get: { path: `${api}/teams/:teamId`, record: 'team' }, parts: { members: { key: 'members', ...(inSocial ? { kind: 'person' } : {}) } },
      id: 'teamId', subtitle: 'visibility',
      href: () => `${pages}/teams`,
    },
    {
      kind: 'dm', label: 'direct messages', social: true,
      list: { path: `${api}/dms` },
      id: 'channel', title: peersOf, subtitle: 'lastMessagePreview', at: 'lastMessageAt',
      href: (id) => `${pages}/dms/${enc(id)}`,
    },
    {
      kind: 'room', label: 'hangout rooms', social: true,
      list: { path: `${api}/rooms` }, get: { path: `${api}/rooms/:slug`, record: 'room' }, parts: { activity: { path: `${api}/rooms/:slug/activity` } },
      id: 'slug', subtitle: 'description',
      href: () => `${pages}/rooms`,
    },
    {
      kind: 'recording', label: 'recordings', social: true,
      list: { path: `${api}/recordings` }, parts: { transcript: { path: `${api}/recordings/:recordingId/transcript` } },
      id: 'recordingId', title: (r) => r['title'] ?? `Recording of ${String(r['lobbyName'] ?? 'a call')}`,
      href: () => `${pages}/recordings`,
    },
    {
      kind: 'call', label: 'calls', social: true,
      list: { path: `${api}/calls` },
      id: 'callId', title: (r) => r['callerName'] ?? r['lobbyName'], subtitle: 'direction',
      href: () => `${pages}/calls`,
    },
    ...(inSocial ? [{
      kind: 'person', label: 'people', one: 'person', social: true,
      list: { path: `${api}/people` },
      id: 'userId', title: 'displayName', subtitle: (r: Rec) => (Array.isArray(r['roles']) ? (r['roles'] as string[]).join(', ') : undefined),
      href: (id: string) => `/social/contacts/${enc(id)}`,
    } satisfies KindSpec] : []),
  ];
}

const ORGIQ: readonly KindSpec[] = [
  {
    kind: 'initiative', label: 'initiatives',
    list: { path: '/api/graph/projects', params: { limit: '50' }, filters: { scope: 'scope', status: 'status' }, scopes: ['mine', 'all'] },
    get: { path: '/api/graph/projects/:id' },
    parts: {
      work: { path: '/api/graph/projects/:id/work', kind: 'work-item' },
      decisions: { path: '/api/graph/projects/:id/decisions', kind: 'decision' },
      activity: { path: '/api/graph/projects/:id/activity' },
      documents: { path: '/api/graph/projects/:projectId/workspace-documents', kind: 'document' },
    },
    subtitle: (r) => (r['ownerName'] ? `Owner: ${String(r['ownerName'])}` : undefined), at: ['lastActivityAt', 'createdAt'],
    href: (id) => `/iq/projects/${enc(id)}`,
  },
  {
    kind: 'work-item', label: 'work items',
    list: { path: '/api/graph/work' },
    parts: { comments: { path: '/api/graph/work-items/:id/comments' }, criteria: { path: '/api/graph/work-items/:id/criteria' }, documents: { path: '/api/graph/work-items/:id/documents', kind: 'document' } },
    subtitle: (r) => [r['key'], r['assigneeName']].filter(Boolean).join(' · ') || undefined,
    href: (_id, r) => (typeof r['projectId'] === 'string' ? `/iq/projects/${enc(r['projectId'])}` : undefined),
  },
  {
    // Read through an initiative's or a work item's documents part, then get by ref; no flat list route.
    kind: 'document', label: 'documents',
    get: { path: '/api/graph/documents/:documentId' },
    href: (id) => `/iq/documents/${enc(id)}`,
  },
  {
    kind: 'decision', label: 'decisions',
    list: { path: '/api/graph/decisions' }, get: { path: '/api/graph/decisions/:id' },
    title: 'topic', at: ['decidedAt', 'createdAt'],
    href: (id) => `/iq/decisions/${enc(id)}`,
  },
  {
    kind: 'design', label: 'design threads',
    list: { path: '/api/designs', key: 'reviews' }, get: { path: '/api/designs/:id' },
    href: (id) => `/iq/designs/${enc(id)}`,
  },
  {
    kind: 'job', label: 'jobs in the work queue', one: 'job in the work queue',
    list: { path: '/api/work/jobs', key: 'jobs' }, get: { path: '/api/work/jobs/:id' },
    subtitle: 'botName', href: (id) => `/iq/work/${enc(id)}`,
  },
  {
    kind: 'finding', label: 'findings',
    list: { path: '/api/work/findings', key: 'findings', filters: { status: 'status' } },
    subtitle: (r) => [r['severity'], r['sweep']].filter(Boolean).join(' · ') || undefined, at: ['lastSeenAt', 'createdAt'],
    href: () => '/iq/work/findings',
  },
  {
    kind: 'proposal', label: 'graph change proposals',
    list: { path: '/api/work/proposals', key: 'proposals' },
    title: 'rationale', subtitle: 'kind', href: () => '/iq/work/changes',
  },
  {
    // The HITL inbox (§2.10's one observability read voice lists): what waits on an ApproveTransaction holder; decide's refs.
    kind: 'hitl-approval', label: 'pending transaction approvals', one: 'pending transaction approval', action: 'ViewObservability',
    list: { path: '/api/observability/approvals', key: 'approvals', params: { status: 'PENDING' } },
    id: 'approvalId', title: (r) => r['reason'] ?? (r['agentId'] ? `A transaction from ${String(r['agentId'])}` : undefined), subtitle: 'agentId', at: 'requestedAt',
    href: () => '/admin/observability/approvals',
  },
  {
    kind: 'consult', label: 'consults',
    list: { path: '/api/lab/consults', key: 'consults' }, get: { path: '/api/lab/consults/:id', record: 'consult' },
    title: 'question', subtitle: 'repo', href: () => '/iq/work',
  },
  {
    kind: 'bot', label: 'bots', action: 'ManageBots', readRoles: RUN_READERS,
    list: { path: '/api/bots', key: 'bots' }, get: { path: '/api/bots/:id', record: 'bot' }, parts: { runs: { path: '/api/bots/:id/runs' } },
    subtitle: 'cronExpr', status: (r) => (r['pausedReason'] ? 'paused' : r['enabled'] === false ? 'disabled' : 'enabled'), at: 'lastRunAt',
    href: (id) => `/admin/bots/${enc(id)}`,
  },
  {
    kind: 'run', label: 'runs', action: 'ManageBots', readRoles: RUN_READERS,
    list: { path: '/api/runs', key: 'runs', filters: { status: 'status' } }, get: { path: '/api/runs/:id', record: 'run' },
    parts: { steps: { path: '/api/runs/:id/steps' } },
    title: ['title', 'definitionId'], subtitle: 'triggerType', href: (id) => `/iq/runs/${enc(id)}`,
  },
  {
    kind: 'computer', label: 'computers', action: 'ManageDevbox', readRoles: FLEET_READERS,
    list: { path: '/api/devbox/boxes', key: 'boxes' },
    title: ['label', 'name', 'id'], subtitle: ['project', 'orgProjectName'], href: (id) => `/admin/devbox?box=${enc(id)}`,
  },
  {
    // ManageEnvironments is not one of the portal's can() actions: the read tier alone opens it here; the route decides the rest.
    kind: 'environment', label: 'environments', readRoles: ENV_READERS,
    list: { path: '/api/environments', key: 'environments' }, get: { path: '/api/environments/:id', record: 'environment' }, parts: { runs: { path: '/api/environments/:id/runs' } },
  },
  {
    kind: 'runbook', label: 'runbooks',
    list: { path: '/api/runbooks', key: 'runbooks' }, get: { path: '/api/runbooks/:id', record: 'runbook' },
    parts: { versions: { path: '/api/runbooks/:id/versions' }, applications: { path: '/api/runbooks/:id/applications' } },
    subtitle: 'summary', href: (id) => `/iq/runbooks/${enc(id)}`,
  },
  {
    kind: 'runbook-proposal', label: 'runbook proposals',
    list: { path: '/api/runbooks/proposals', key: 'proposals' }, get: { path: '/api/runbooks/proposals/:pid', record: 'proposal' },
    title: ['proposed.title', 'title'], subtitle: 'kind', href: (id) => `/iq/runbooks/proposals/${enc(id)}`,
  },
  {
    kind: 'change', label: 'agent changes', action: 'ManageDevbox',
    list: { path: '/api/sdlc/changes', key: 'changes' }, get: { path: '/api/sdlc/changes/:id', record: 'change' }, parts: { evaluations: { path: '/api/sdlc/changes/:id/evaluations' } },
    href: (id) => `/admin/changes/${enc(id)}`,
  },
  {
    kind: 'sprint', label: 'sprints',
    list: { path: '/api/sprints', key: 'sprints', filters: { scope: 'scope' }, scopes: ['mine', 'all'] },
    subtitle: 'orgProjectName', at: 'startsOn', href: () => '/iq/projects?lens=sprints',
  },
  {
    kind: 'deck', label: 'decks',
    list: { path: '/api/initiative-decks' }, get: { path: '/api/initiative-decks/:id' },
    href: (id) => `/iq/decks/${enc(id)}`,
  },
  {
    kind: 'codebase', label: 'codebases', action: 'DispatchAgentRun', readRoles: CODEBASE_READERS,
    list: { path: '/api/agent-projects', key: 'projects' }, parts: { runs: { path: '/api/agent-projects/:id/runs' } },
    title: 'repoFullName', subtitle: 'orgProjectName', href: () => '/admin/projects',
  },
  {
    kind: 'person', label: 'people', one: 'person', getAction: 'ViewOrgChart',
    list: { path: '/api/roster', key: 'people' }, get: { path: '/api/graph/people/:personId' },
    parts: { work: { path: '/api/graph/people/:personId/work', kind: 'work-item' }, evidence: { path: '/api/graph/people/:personId/evidence' } },
    subtitle: ['title', 'department'], title: 'name',
    href: (id) => `/iq/search?tab=connections&selection=${enc(`person:${id}`)}`,
  },
  {
    kind: 'saved-search', label: 'saved searches', action: 'Search',
    list: { path: '/api/saved-searches', key: 'searches' },
    href: (_id, r) => (typeof r['query'] === 'string' ? `/iq/search?q=${enc(r['query'])}` : '/iq/search'),
  },
  {
    kind: 'library', label: 'library items', one: 'library item',
    list: { path: '/api/library', key: 'assets' }, get: { path: '/api/library/:id', record: 'asset' },
    subtitle: 'ownerName', href: (id) => `/iq/library/${enc(id)}`,
  },
  {
    kind: 'brief', label: 'session briefs', action: 'ViewSessionBrief',
    list: { path: '/api/briefs', key: 'briefs' }, get: { path: '/api/runs/:ref/brief', record: 'brief' },
    id: 'run_ref', title: 'run_ref', subtitle: 'repo', at: 'assembled_at',
    href: (id) => `/iq/runbooks/briefs/${enc(id)}`,
  },
  ...socialKinds('/api/social/plane', '/iq/communication', false),
];

const SOCIAL: readonly KindSpec[] = socialKinds('/api/social', '/social', true);

const ASSESSMENT: readonly KindSpec[] = [
  {
    kind: 'team', label: 'teams', action: 'ViewAssessment',
    list: { path: '/api/assessment/teams' }, get: { path: '/api/assessment/teams/:id', record: 'team' },
    parts: {
      evidence: { path: '/api/assessment/teams/:id/evidence' }, exceptions: { path: '/api/assessment/teams/:id/exceptions', key: 'exceptions' },
      recommendations: { path: '/api/assessment/teams/:id/recommendations' }, stories: { path: '/api/assessment/teams/:id/stories' },
    },
    subtitle: (r) => [r['cohort_label'], r['assessment_lead'] ? `Lead: ${String(r['assessment_lead'])}` : undefined].filter(Boolean).join(' · ') || undefined,
    href: (id) => `/assessment/teams/${enc(id)}`,
  },
  {
    kind: 'run', label: 'runs', action: 'ViewAssessment',
    list: { path: '/api/assessment/runs', key: 'runs' }, get: { path: '/api/assessment/runs/:runId' },
    title: 'command', subtitle: 'summary', href: (id) => `/assessment/runs/${enc(id)}`,
  },
  {
    kind: 'feedback', label: 'follow-ups', action: 'ViewAssessment',
    list: { path: '/api/assessment/feedback', key: 'tasks' }, get: { path: '/api/assessment/feedback/:taskId' },
    title: 'question', subtitle: 'team_id', href: (id) => `/assessment/feedback/${enc(id)}`,
  },
  {
    kind: 'submission', label: 'submissions', action: 'ViewAssessment',
    list: { path: '/api/assessment/submissions', key: 'envelopes' },
    id: 'envelope_id', title: (r) => r['team_name_raw'] ?? r['team_id'], subtitle: 'submitter.name', at: ['submitted_at', 'received_at'],
    href: () => '/assessment/submissions',
  },
  {
    kind: 'deck', label: 'decks', action: 'ViewAssessment',
    list: { path: '/api/assessment/decks' }, get: { path: '/api/assessment/decks/:id' },
    href: (id) => `/assessment/decks/${enc(id)}`,
  },
  {
    kind: 'recommendation', label: 'recommendations', action: 'ViewAssessment',
    list: { path: '/api/assessment/recommendations', key: 'teams' },
    subtitle: 'top.title', href: (id) => `/assessment/teams/${enc(id)}`,
  },
  // Assessment has teams of its own, so Social's are `social-team` here.
  ...socialKinds('/api/social/plane', '/assessment/communication', false, 'social-team'),
];

const PIPELINES: readonly KindSpec[] = [
  {
    kind: 'run', label: 'runs', action: 'ViewPipelines',
    list: { path: '/api/pipelines/runs', key: 'runs', filters: { status: 'status' } }, get: { path: '/api/pipelines/runs/:id', record: 'run' },
    parts: { steps: { path: '/api/pipelines/runs/:id/steps', key: 'steps' } },
    title: ['title', 'definitionId'], subtitle: 'triggerType', href: (id) => `/pipelines/runs/${enc(id)}`,
  },
  {
    kind: 'definition', label: 'definitions', action: 'ViewPipelines',
    list: { path: '/api/pipelines/definitions', key: 'definitions' }, get: { path: '/api/pipelines/definitions/:id', record: 'definition' },
    subtitle: 'kind', href: (id) => `/pipelines/definitions/${enc(id)}`,
  },
  {
    kind: 'runbook', label: 'runbooks', action: 'ViewPipelines',
    list: { path: '/api/pipelines/runbooks', key: 'runbooks' }, href: () => '/pipelines/runbooks',
  },
  {
    kind: 'approval', label: 'approvals', action: 'ViewPipelines',
    list: { path: '/api/pipelines/approvals', key: 'approvals' }, subtitle: 'stepId', href: (id) => `/pipelines/approvals/${enc(id)}`,
  },
  {
    kind: 'artifact', label: 'artifacts', action: 'ViewPipelines',
    list: { path: '/api/pipelines/artifacts', key: 'artifacts' }, subtitle: 'kind', href: () => '/pipelines/artifacts',
  },
  {
    kind: 'deck', label: 'decks', action: 'ViewPipelines',
    list: { path: '/api/pipelines/decks' }, get: { path: '/api/pipelines/decks/:id' }, href: (id) => `/pipelines/decks/${enc(id)}`,
  },
  ...socialKinds('/api/social/plane', '/pipelines/communication', false),
];

const requestFields: Pick<KindSpec, 'title' | 'subtitle' | 'at'> = {
  title: 'item.title',
  subtitle: (r) => {
    const req = dig(r, 'requester.displayName'), ben = dig(r, 'beneficiary.displayName');
    return typeof req === 'string' ? (typeof ben === 'string' && ben !== req ? `${req} for ${ben}` : req) : undefined;
  },
  at: 'submittedAt',
};

const ACCESS: readonly KindSpec[] = [
  {
    kind: 'request', label: 'access requests', action: 'ViewAccess',
    list: { path: '/api/access/requests', key: 'items', filters: { scope: 'scope', q: 'q' }, scopes: ['mine', 'reports'] },
    get: { path: '/api/access/requests/:id' }, ...requestFields,
    href: (id) => `/access/requests/${enc(id)}`,
  },
  {
    kind: 'approval', label: 'requests waiting on your decision', one: 'request waiting on your decision', action: 'DecideAccess',
    list: { path: '/api/access/approvals', key: 'items' }, ...requestFields,
    href: (id) => `/access/requests/${enc(id)}`,
  },
  {
    kind: 'catalog-item', label: 'catalog items', action: 'ViewAccess',
    list: { path: '/api/access/catalog', key: 'items' }, subtitle: 'kind',
    href: (id) => `/access/requests/new?item=${enc(id)}`,
  },
  {
    kind: 'review', label: 'access reviews', action: 'ViewAccess',
    list: { path: '/api/access/reviews', key: 'items' }, get: { path: '/api/access/reviews/:id', record: 'review' },
    parts: { items: { key: 'items', kind: 'review-item' } }, subtitle: 'owner.displayName', at: ['closesAt', 'openedAt'],
    href: (id) => `/access/reviews/${enc(id)}`,
  },
  {
    // A review's standing grants, read as its `items` part: each a ref decide can name (`review-item:<review>/<item>`).
    kind: 'review-item', label: 'review items', action: 'ViewAccess',
    id: (r) => (typeof r['reviewId'] === 'string' && typeof r['id'] === 'string' ? `${r['reviewId']}/${r['id']}` : undefined),
    title: 'user.displayName', subtitle: (r) => [r['tenant'], r['role']].filter(Boolean).join(' ') || undefined, status: (r) => r['decision'] ?? 'undecided',
    href: (id) => `/access/reviews/${enc(id.split('/')[0]!)}`,
  },
  {
    kind: 'delegation', label: 'delegations', action: 'ViewAccess',
    list: { path: '/api/access/delegations', key: 'items' },
    title: (r) => `${String(dig(r, 'delegator.displayName') ?? 'Someone')} to ${String(dig(r, 'delegate.displayName') ?? 'someone')}`, at: ['startsAt', 'createdAt'],
    href: () => '/access/approvals',
  },
  {
    kind: 'policy', label: 'policies', action: 'ViewAccess',
    list: { path: '/api/access/policies', key: 'items' }, subtitle: 'severity', href: (id) => `/access/policies/${enc(id)}`,
  },
  {
    kind: 'audit-event', label: 'audit events', action: 'ViewAccess',
    list: { path: '/api/access/audit', key: 'items' }, title: 'subject', subtitle: 'kind', href: () => '/access/audit',
  },
];

export const KIND_TABLES: Readonly<Record<string, readonly KindSpec[]>> = {
  orgiq: ORGIQ, social: SOCIAL, assessment: ASSESSMENT, pipelines: PIPELINES, access: ACCESS,
};

export function kindSpec(tenant: string, kind: string): KindSpec | undefined {
  return KIND_TABLES[tenant]?.find((k) => k.kind === kind);
}

/** Every route a tenant's kinds read, as `GET /path` (the table test pins each to the inventory). */
export function kindRoutes(tenant: string): string[] {
  const out = new Set<string>();
  for (const k of KIND_TABLES[tenant] ?? []) {
    if (k.list) out.add(`GET ${k.list.path}`);
    if (k.get) out.add(`GET ${k.get.path}`);
    for (const p of Object.values(k.parts ?? {})) if (p.path) out.add(`GET ${p.path}`);
  }
  return [...out];
}
