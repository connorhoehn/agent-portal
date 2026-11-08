// The voice navigator's tool catalogue as the dock sees it
// (docs/voice-navigator-spec.md §4). The middleware's copy
// (middleware/src/lib/voice/catalogue.ts) is the one the session is minted
// with, and the mint answers only the tool NAMES; the dock needs the full
// schemas to validate a call before running it, the `confirm` flag and the
// Cedar action it checks with can(). `__tests__/catalogue.test.ts` loads the
// middleware's table and fails on any drift in names, schemas, gates, tenants
// or confirm flags, so this file cannot quietly disagree with what the model
// was offered.
//
// No imports beyond types: plain `node --test` loads it.

import type { Action } from '../capabilities';

export type VoiceToolKind = 'read' | 'navigate' | 'machine' | 'people';
export type VoiceToolBacking = 'search' | 'social-activity' | 'route' | 'work';

/** The subset of JSON Schema the catalogue uses. */
export interface JsonSchema {
  type: 'object' | 'string' | 'integer' | 'array' | 'boolean';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  enum?: readonly string[];
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: JsonSchema;
  minItems?: number;
  maxItems?: number;
}

export interface VoiceToolSpec {
  name: string;
  parameters: JsonSchema;
  kind: VoiceToolKind;
  backing: VoiceToolBacking;
  /** The dock shows a Confirm / Cancel card before running it (§5). */
  confirm: boolean;
  /** The Cedar action can() checks first; null = the route's own floor (the runner gates by tenant/role). */
  action: Action | null;
  says: string;
  tenants: readonly string[];
}

export const VOICE_TENANTS = ['orgiq', 'social', 'assessment', 'pipelines', 'access'] as const;
/** Where the machine and people tools reach (the middleware's PEOPLE_TENANTS); the other tenants get reads and navigation only. */
const PEOPLE_TENANTS = ['orgiq', 'social'] as const;

/** Page ids `navigate` may name (the middleware's NAVIGATE_PAGES, ids and tenants); an id may repeat across tenants. */
export const NAVIGATE_PAGE_IDS: ReadonlyArray<{ id: string; tenants: readonly string[] }> = [
  { id: 'search', tenants: ['orgiq'] },
  { id: 'computer-lab', tenants: ['orgiq'] },
  { id: 'initiatives', tenants: ['orgiq'] },
  { id: 'bots', tenants: ['orgiq'] },
  { id: 'findings', tenants: ['orgiq'] },
  { id: 'teams', tenants: ['social'] },
  { id: 'channels', tenants: ['social'] },
  { id: 'contacts', tenants: ['social'] },
  { id: 'teams', tenants: ['assessment'] },
  { id: 'submissions', tenants: ['assessment'] },
  { id: 'reports', tenants: ['assessment'] },
  { id: 'feedback', tenants: ['assessment'] },
  { id: 'runs', tenants: ['assessment'] },
  { id: 'definitions', tenants: ['pipelines'] },
  { id: 'runbooks', tenants: ['pipelines'] },
  { id: 'queues', tenants: ['pipelines'] },
  { id: 'runs', tenants: ['pipelines'] },
  { id: 'approvals', tenants: ['pipelines'] },
  { id: 'artifacts', tenants: ['pipelines'] },
  { id: 'catalog', tenants: ['access'] },
  { id: 'requests', tenants: ['access'] },
  { id: 'open-requests', tenants: ['access'] },
  { id: 'new-request', tenants: ['access'] },
  { id: 'approvals', tenants: ['access'] },
  { id: 'workspaces', tenants: ['*'] },
];

/** The record types `search` may name, per tenant (the middleware's SEARCH_RECORD_TYPES: each tenant's backend search index, people included in orgiq). */
export const SEARCH_RECORD_TYPES: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['person', 'team', 'initiative', 'work', 'decision', 'knowledge', 'asset', 'recording'],
  social: ['channel', 'message', 'pin', 'dm', 'contact', 'team', 'room', 'recording', 'calllog', 'huddle'],
  assessment: ['team', 'dimension', 'exception', 'feedback', 'run', 'submission', 'story', 'document'],
  pipelines: ['run', 'definition', 'runbook', 'bot', 'approval', 'queue', 'artifact'],
  access: ['request', 'catalog', 'policy', 'event', 'review', 'review-item', 'delegation'],
};

/** The Cedar action each tenant's search mount is gated on (the middleware's SEARCH_ACTIONS). */
export const SEARCH_ACTIONS: Readonly<Record<string, Action>> = {
  orgiq: 'Search', social: 'ViewSocial', assessment: 'ViewAssessment', pipelines: 'ViewPipelines', access: 'ViewAccess',
};

/** `search`'s type enum for one tenant, or every tenant's types (null) for the base row. */
export function searchRecordTypes(tenant: string | null): string[] {
  if (tenant != null) return [...(SEARCH_RECORD_TYPES[tenant] ?? [])];
  return [...new Set(Object.values(SEARCH_RECORD_TYPES).flat())];
}

/** `activity`'s scopes per tenant (the middleware's ACTIVITY_SCOPES): no `work` outside orgiq (G6). */
export const ACTIVITY_SCOPES: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['online', 'live-calls', 'missed-calls', 'messages', 'pins', 'work', 'recent'],
  social: ['online', 'live-calls', 'missed-calls', 'messages', 'pins', 'recent'],
};

/**
 * What `list` may list and `get` may read, per tenant (catalogue v2, V2-5):
 * the kinds of portal lib/voice/kinds.ts KIND_TABLES, each a read the
 * kind's own page makes (the portal's table test pins every route to
 * docs/voice-tool-inventory.json with decision `read`; the drift test pins
 * this list to the table).
 */
export const LIST_KINDS: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['initiative', 'work-item', 'decision', 'design', 'job', 'finding', 'proposal', 'consult', 'bot', 'run', 'computer', 'environment', 'runbook', 'runbook-proposal', 'change', 'sprint', 'deck', 'codebase', 'person', 'saved-search', 'library', 'brief', 'channel', 'team', 'dm', 'room', 'recording', 'call'],
  social: ['channel', 'team', 'dm', 'room', 'recording', 'call', 'person'],
  assessment: ['team', 'run', 'feedback', 'submission', 'deck', 'recommendation', 'channel', 'social-team', 'dm', 'room', 'recording', 'call'],
  pipelines: ['run', 'definition', 'runbook', 'approval', 'artifact', 'deck', 'channel', 'team', 'dm', 'room', 'recording', 'call'],
  access: ['request', 'approval', 'catalog-item', 'review', 'delegation', 'policy', 'audit-event'],
};

/** The parts `get` may read of a record, per tenant (the union of that tenant's kinds' parts). */
export const GET_PARTS: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['work', 'decisions', 'activity', 'documents', 'comments', 'criteria', 'runs', 'steps', 'versions', 'applications', 'evaluations', 'evidence', 'members', 'transcript'],
  social: ['members', 'recent', 'activity', 'transcript'],
  assessment: ['evidence', 'exceptions', 'recommendations', 'stories', 'members', 'activity', 'transcript'],
  pipelines: ['steps', 'members', 'activity', 'transcript'],
  access: ['items'],
};

/** `list`'s kind enum for one tenant, or every tenant's kinds (null) for the catalogue's base row. */
export function listKinds(tenant: string | null): string[] {
  if (tenant != null) return [...(LIST_KINDS[tenant] ?? [])];
  return [...new Set(Object.values(LIST_KINDS).flat())];
}

/** `get`'s part enum for one tenant, or every tenant's parts (null). */
export function getParts(tenant: string | null): string[] {
  if (tenant != null) return [...(GET_PARTS[tenant] ?? [])];
  return [...new Set(Object.values(GET_PARTS).flat())];
}

/**
 * What `summary` may read, per tenant (catalogue v2, V2-6): one aggregate
 * each, through the page's own read. orgiq: the sweeps (what
 * bot_sweep_status read), the work queue, the fleet of computers, paired
 * machines, platform health, ingestion, today, unread discussions and who is
 * live on the plane; Social: live and unread; assessment: the program rollup;
 * pipelines: what failed and the dead letters; access: its summary.
 */
export const SUMMARY_KINDS: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['sweeps', 'work', 'fleet', 'machines', 'health', 'ingest', 'today', 'unread', 'live'],
  social: ['live', 'unread'],
  assessment: ['rollup', 'live', 'unread'],
  pipelines: ['pipelines', 'live', 'unread'],
  access: ['access', 'unread'],
};

/** `summary`'s kind enum for one tenant, or every tenant's kinds (null). */
export function summaryKinds(tenant: string | null): string[] {
  if (tenant != null) return [...(SUMMARY_KINDS[tenant] ?? [])];
  return [...new Set(Object.values(SUMMARY_KINDS).flat())];
}

/** `activity`'s scope enum for one tenant, or every tenant's scopes (null) for the base row. */
export function activityScopes(tenant: string | null): string[] {
  if (tenant != null) return [...(ACTIVITY_SCOPES[tenant] ?? [])];
  return [...new Set(Object.values(ACTIVITY_SCOPES).flat())];
}

/** What `queue_work` may queue, per tenant (the middleware's QUEUE_WORK_KINDS, G19). */
export const QUEUE_WORK_KINDS: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['sweep', 'bot-run'],
  pipelines: ['pipeline'],
};
export type QueueWorkKind = 'sweep' | 'pipeline' | 'bot-run';

/** The Cedar action each kind's page button is gated on (the middleware's QUEUE_WORK_ACTIONS): the dock's can() per kind. */
export const QUEUE_WORK_ACTIONS: Readonly<Record<QueueWorkKind, Action>> = {
  sweep: 'DispatchAgentRun', pipeline: 'RunPipeline', 'bot-run': 'ManageBots',
};

/** `queue_work`'s kind enum for one tenant, or every tenant's kinds (null) for the base row. */
export function queueWorkKinds(tenant: string | null): string[] {
  if (tenant != null) return [...(QUEUE_WORK_KINDS[tenant] ?? [])];
  return [...new Set(Object.values(QUEUE_WORK_KINDS).flat())];
}

/**
 * The phrase ids `run_command` may name; actions.ts PHRASE_TABLE owns the
 * command text (§6). The mint narrows this enum to the phrases the server's
 * allowlist runs (G9), so the dock validates against the full list and the
 * planner checks the composed command against GET /api/devbox/allowlist.
 */
export const RUN_COMMAND_PHRASES = [
  'latest-commits-since-yesterday', 'commits-since', 'status', 'diff-stat', 'list-files', 'working-directory',
  'test', 'test-python', 'lint', 'build',
] as const;
export type RunCommandPhrase = typeof RUN_COMMAND_PHRASES[number];

/** What `since` takes (run_command's commits-since, list, summary, activity); parseSince and gitSince read exactly these. */
const SINCE_WORDS = '"yesterday", "last night", "today", "this morning", "3 hours ago", "3 days ago", "last week" or a YYYY-MM-DD date';

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra });
const limit: JsonSchema = { type: 'integer', minimum: 1, maximum: 10, description: 'How many results, 1 to 10. Default 5.' };
const searchScope = str('Where to search: "workspace" (the default) or one initiative id, to search inside that initiative only.', { minLength: 1, maxLength: 200 });

export const VOICE_TOOLS: readonly VoiceToolSpec[] = [
  {
    name: 'navigate',
    parameters: obj({
      page: str('The page to open.', { enum: [...new Set(NAVIGATE_PAGE_IDS.map((p) => p.id))] }),
      params: obj({
        q: str('Search text for the page, when it takes one.'),
        type: str('A result type filter, when the page takes one.'),
        id: str('A record id, when the page opens one.'),
      }),
    }, ['page']),
    kind: 'navigate', backing: 'route', confirm: false, action: null, says: 'Opening search.', tenants: VOICE_TENANTS,
  },
  {
    name: 'search',
    parameters: obj({
      query: str('What to search for, in the user\'s words.', { minLength: 1, maxLength: 200 }),
      type: str('Which kind of record.', { enum: searchRecordTypes(null) }),
      scope: searchScope,
      sort: str('relevance (default) or recent.', { enum: ['relevance', 'recent'] }),
      limit,
      answer: { type: 'boolean', description: 'True when the user asked a question that wants one fact (who, how many, which): the backend answers it from the index, with the records it read.' },
    }, ['query']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Searching for the Kubernetes experts.', tenants: VOICE_TENANTS,
  },
  {
    name: 'open_result',
    parameters: obj({
      ref: str('The row\'s ref from the result, or its position in the last result ("1" to "10").', { minLength: 1, maxLength: 200 }),
    }, ['ref']),
    kind: 'navigate', backing: 'route', confirm: false, action: null, says: 'Opening the first result.', tenants: VOICE_TENANTS,
  },
  {
    name: 'list',
    parameters: obj({
      kind: str('Which kind of record.', { enum: listKinds(null) }),
      filter: obj({
        q: str('Words the record\'s name should contain, as the user said them.', { minLength: 1, maxLength: 120 }),
        status: str('A status, as the page shows it (open, failed, active, pending…).', { minLength: 1, maxLength: 40 }),
        scope: str('"mine" (the user\'s own), "all", or "reports" (the user\'s reports\' access requests), where the kind takes one.', { enum: ['mine', 'all', 'reports'] }),
        since: str(`Only records since: ${SINCE_WORDS}.`, { minLength: 1, maxLength: 40 }),
      }),
      limit,
    }, ['kind']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Looking up your initiatives.', tenants: VOICE_TENANTS,
  },
  {
    name: 'get',
    parameters: obj({
      ref: str('A row\'s ref exactly as a result gave it (e.g. "initiative:p-12"), or its position in the last result ("1" for the first row). Never a name or a path.', { minLength: 1, maxLength: 200 }),
      part: str('One part of the record instead of its summary, where the kind has it (its work, steps, members, versions…).', { enum: getParts(null) }),
    }, ['ref']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Reading that initiative.', tenants: VOICE_TENANTS,
  },
  {
    name: 'open_computer_lab',
    parameters: obj({ initiativeId: str('The initiative to focus, when the user named one.') }),
    kind: 'navigate', backing: 'route', confirm: false, action: null, says: 'Opening the Computer Lab.', tenants: ['orgiq'],
  },
  {
    name: 'start_computer',
    parameters: obj({
      initiativeIds: {
        type: 'array', minItems: 1, maxItems: 10,
        description: 'The initiatives: ids from a list of initiatives or a search, or the names the user said.',
        items: str('An initiative id or name.', { minLength: 1, maxLength: 200 }),
      },
    }, ['initiativeIds']),
    kind: 'machine', backing: 'work', confirm: true, action: 'ManageDevbox', says: 'Starting a computer for Alpha.', tenants: ['orgiq'],
  },
  {
    name: 'open_shell',
    parameters: obj({ computerId: str('The computer.', { minLength: 1 }), cwd: str('A starting directory.') }, ['computerId']),
    kind: 'machine', backing: 'route', confirm: false, action: 'OpenDevboxShell', says: 'Opening a shell on Alpha.', tenants: ['orgiq'],
  },
  {
    name: 'run_command',
    parameters: obj({
      computerId: str('The computer.', { minLength: 1 }),
      phrase: str('Which command.', { enum: [...RUN_COMMAND_PHRASES] }),
      since: str(`For commits-since: ${SINCE_WORDS}.`, { maxLength: 40 }),
    }, ['computerId', 'phrase']),
    kind: 'machine', backing: 'work', confirm: true, action: 'OpenDevboxShell', says: 'Running git log on Alpha.', tenants: ['orgiq'],
  },
  {
    name: 'summary',
    parameters: obj({
      kind: str('Which aggregate: "sweeps" (sweep and bot runs that failed, open findings), "work" (the work queue), "fleet" (the computers), "machines" (paired machines), "health" (agent runs in the last 24 hours), "ingest", "today", "unread" (discussions), "live" (who is online, in a call), "pipelines" (failed runs, dead letters), "rollup" (the assessment program), "access".', { enum: summaryKinds(null) }),
      since: str(`Since when, for sweeps, pipelines, machines and unread: ${SINCE_WORDS}; yesterday by default for sweeps and pipelines.`, { minLength: 1, maxLength: 40 }),
    }, ['kind']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Checking the sweeps since yesterday.', tenants: VOICE_TENANTS,
  },
  {
    name: 'activity',
    parameters: obj({
      scope: str('What to read: "online" (who is online now), "live-calls" (who is in a call or huddle now), "missed-calls" (the user\'s missed calls), "messages", "pins", "work" (what a person worked on, in the Work workspace) or "recent" (messages, pins, missed calls and, in Work, work items, since a time; yesterday by default).', { enum: activityScopes(null) }),
      since: str(`Since when, for messages, pins, missed-calls, work and recent: ${SINCE_WORDS}.`, { minLength: 1, maxLength: 40 }),
      who: str('One person, as the user named them, to narrow the read to ("what did Ada work on", "is Ada on a call").', { minLength: 1, maxLength: 120 }),
    }, ['scope']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Checking who is on a call.', tenants: PEOPLE_TENANTS,
  },
  {
    name: 'send_chat_message',
    parameters: obj({
      target: obj({
        kind: str('Where it goes.', { enum: ['team', 'channel', 'dm'] }),
        name: str('The team, channel or person, as the user said it.', { minLength: 1, maxLength: 120 }),
      }, ['kind', 'name']),
      text: str('The message, exactly as dictated.', { minLength: 1, maxLength: 2000 }),
    }, ['target', 'text']),
    kind: 'people', backing: 'social-activity', confirm: true, action: 'PostMessage', says: "I'll post that to #platform once you confirm.", tenants: PEOPLE_TENANTS,
  },
  {
    name: 'start_call',
    parameters: obj({
      target: obj({
        kind: str('Where the call is: a team, a channel, or one person (dm).', { enum: ['team', 'channel', 'dm'] }),
        name: str('The team, channel or person, as the user said it.', { minLength: 1, maxLength: 120 }),
      }, ['kind', 'name']),
    }, ['target']),
    kind: 'people', backing: 'social-activity', confirm: true, action: 'StartCall', says: "I'll start a huddle in #platform once you confirm.", tenants: PEOPLE_TENANTS,
  },
  {
    name: 'set_status',
    parameters: obj({
      status: str('The status.', { enum: ['online', 'away', 'busy', 'offline'] }),
      message: str('A short status message.', { maxLength: 120 }),
    }, ['status']),
    kind: 'people', backing: 'social-activity', confirm: false, action: null, says: 'Setting your status to away: out today.', tenants: PEOPLE_TENANTS,
  },
  {
    name: 'queue_work',
    parameters: obj({
      kind: str('What to queue.', { enum: queueWorkKinds(null) }),
      target: str('Which sweep, bot or runbook, as the user said it.', { minLength: 1, maxLength: 200 }),
      note: str('A short label the user gave for this run, shown with it; never an instruction.', { maxLength: 200 }),
    }, ['kind', 'target']),
    kind: 'machine', backing: 'work', confirm: true, action: null, says: 'Queuing the nightly sweep.', tenants: ['orgiq', 'pipelines'],
  },
  {
    name: 'access_request_status',
    parameters: obj({
      query: str('The item asked for or the person, as the user named it; leave out to list them all.', { minLength: 1, maxLength: 120 }),
      scope: str('"mine" (the default): the user\'s own requests; "approvals": the requests waiting on the user\'s decision; "reports": the requests of people the user manages.', { enum: ['mine', 'approvals', 'reports'] }),
    }),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Checking your access requests.', tenants: VOICE_TENANTS,
  },
];

export function voiceToolSpec(name: string): VoiceToolSpec | undefined {
  return VOICE_TOOLS.find((t) => t.name === name);
}

/** Page ids `navigate` offers a session in `tenant`. */
export function navigatePageIds(tenant: string): string[] {
  return [...new Set(NAVIGATE_PAGE_IDS.filter((p) => p.tenants.includes('*') || p.tenants.includes(tenant)).map((p) => p.id))];
}
