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

/** read and navigate ask nothing; machine, people and action (a record's own button: decide, create, update) ask first. */
export type VoiceToolKind = 'read' | 'navigate' | 'machine' | 'people' | 'action';
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
  /** Argument values that skip the card although the tool confirms (computer's open-shell). */
  noConfirm?: Readonly<Record<string, readonly string[]>>;
  /** The gate per argument value where `action` is null (computer: the button each action stands in for). */
  actionBy?: { arg: string; actions: Readonly<Record<string, Action>> };
}

export const VOICE_TENANTS = ['orgiq', 'social', 'assessment', 'pipelines', 'access'] as const;
/** Where the machine and people tools reach (the middleware's PEOPLE_TENANTS); the other tenants get reads and navigation only. */
const PEOPLE_TENANTS = ['orgiq', 'social'] as const;

/** Page ids `open` may name (the middleware's NAVIGATE_PAGES: ids, tenants and the palette's roles); an id may repeat across tenants. */
export const NAVIGATE_PAGE_IDS: ReadonlyArray<{ id: string; tenants: readonly string[]; roles?: readonly string[] }> = [
  { id: 'automate', tenants: ['orgiq'] },
  { id: 'graph-updates', tenants: ['orgiq'] },
  { id: 'work-queue', tenants: ['orgiq'] },
  { id: 'findings', tenants: ['orgiq'] },
  { id: 'initiatives', tenants: ['orgiq'] },
  { id: 'decisions', tenants: ['orgiq'] },
  { id: 'agent-library', tenants: ['orgiq'] },
  { id: 'designs', tenants: ['orgiq'] },
  { id: 'workspace-runs', tenants: ['orgiq'], roles: ['sme', 'program-owner', 'org-leader', 'hr-admin'] },
  { id: 'work-graph', tenants: ['orgiq'] },
  { id: 'local-compute-configuration', tenants: ['orgiq'] },
  { id: 'budgets', tenants: ['orgiq'], roles: ['program-owner', 'org-leader', 'hr-admin'] },
  { id: 'bots', tenants: ['orgiq'], roles: ['sme', 'program-owner', 'org-leader', 'hr-admin'] },
  { id: 'codebases', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'changes', tenants: ['orgiq'], roles: ['program-owner', 'hr-admin'] },
  { id: 'computer-lab', tenants: ['orgiq'], roles: ['sme', 'hr-admin', 'org-leader', 'program-owner'] },
  { id: 'local-compute', tenants: ['orgiq'] },
  { id: 'runbooks', tenants: ['orgiq'] },
  { id: 'runbook-proposals', tenants: ['orgiq'] },
  { id: 'session-briefs', tenants: ['orgiq'] },
  { id: 'search', tenants: ['orgiq'] },
  { id: 'communication', tenants: ['orgiq'] },
  { id: 'scores', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'score-cohorts', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'score-compare', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'prompt-ops-deployed', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'prompt-studio', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'prompt-versions', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'prompt-diff', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'prompt-rollout', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'prompt-evals', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'observability', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'observability-on-call', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'observability-runs', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'agent-architecture', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'knowledge', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'ingest-sources', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'ingest-runs', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'ingest-storage', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'ingest-kb-sync', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'ingest-schedule', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'capabilities', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'traffic', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'invocations-search', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'capability-events', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'tool-calls', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'agent-metrics', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'sessions', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'authz-log', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'memory', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'guardrail-rules', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'drift', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'quality', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'cost', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'approval-queue', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'harness', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'calibration', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'model-compare', tenants: ['orgiq'], roles: ['org-leader', 'hr-admin'] },
  { id: 'identity', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'identity-users', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'identity-policy-sandbox', tenants: ['orgiq'], roles: ['hr-admin'] },
  { id: 'settings', tenants: ['*'] },
  { id: 'teams', tenants: ['assessment'] },
  { id: 'communication', tenants: ['assessment'] },
  { id: 'submissions', tenants: ['assessment'] },
  { id: 'reports', tenants: ['assessment'] },
  { id: 'feedback', tenants: ['assessment'] },
  { id: 'work-graph', tenants: ['assessment'] },
  { id: 'enterprise', tenants: ['assessment'] },
  { id: 'workspace-library', tenants: ['assessment'] },
  { id: 'prompts', tenants: ['assessment'] },
  { id: 'rules', tenants: ['assessment'] },
  { id: 'runs', tenants: ['assessment'] },
  { id: 'assessment-configuration', tenants: ['assessment'], roles: ['assessor', 'lead-assessor', 'program-lead'] },
  { id: 'channels', tenants: ['social'] },
  { id: 'direct-messages', tenants: ['social'] },
  { id: 'calls', tenants: ['social'] },
  { id: 'hangouts', tenants: ['social'] },
  { id: 'contacts', tenants: ['social'] },
  { id: 'teams', tenants: ['social'] },
  { id: 'profile', tenants: ['social'] },
  { id: 'recordings', tenants: ['social'] },
  { id: 'work-graph', tenants: ['social'] },
  { id: 'social-configuration', tenants: ['social'] },
  { id: 'social-settings', tenants: ['social'] },
  { id: 'definitions', tenants: ['pipelines'] },
  { id: 'runbooks', tenants: ['pipelines'] },
  { id: 'queues', tenants: ['pipelines'] },
  { id: 'runs', tenants: ['pipelines'] },
  { id: 'work-graph', tenants: ['pipelines'] },
  { id: 'communication', tenants: ['pipelines'] },
  { id: 'approvals', tenants: ['pipelines'] },
  { id: 'artifacts', tenants: ['pipelines'] },
  { id: 'agents', tenants: ['pipelines'] },
  { id: 'bots', tenants: ['pipelines'] },
  { id: 'commands', tenants: ['pipelines'] },
  { id: 'pipelines-configuration', tenants: ['pipelines'], roles: ['pipeline-admin'] },
  { id: 'pipeline-settings', tenants: ['pipelines'] },
  { id: 'catalog', tenants: ['access'] },
  { id: 'requests', tenants: ['access'] },
  { id: 'open-requests', tenants: ['access'] },
  { id: 'new-request', tenants: ['access'] },
  { id: 'approvals', tenants: ['access'], roles: ['approver', 'access-admin'] },
  { id: 'policies', tenants: ['access'] },
  { id: 'reviews', tenants: ['access'] },
  { id: 'open-reviews', tenants: ['access'] },
  { id: 'audit', tenants: ['access'] },
  { id: 'access-configuration', tenants: ['access'], roles: ['access-admin'] },
  { id: 'access-settings', tenants: ['access'] },
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
  orgiq: ['initiative', 'work-item', 'decision', 'design', 'job', 'finding', 'proposal', 'hitl-approval', 'consult', 'bot', 'run', 'computer', 'environment', 'runbook', 'runbook-proposal', 'change', 'sprint', 'deck', 'codebase', 'person', 'saved-search', 'library', 'brief', 'channel', 'team', 'dm', 'room', 'recording', 'call'],
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

/**
 * The kinds `open` resolves by name, per tenant (catalogue v2, V2-4): the
 * list kinds whose rows open on a page (portal lib/voice/kinds.ts, each
 * kind's href built from the id, never taken from the model).
 */
export const OPEN_KINDS: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['initiative', 'work-item', 'decision', 'design', 'job', 'finding', 'proposal', 'hitl-approval', 'consult', 'bot', 'run', 'computer', 'runbook', 'runbook-proposal', 'change', 'sprint', 'deck', 'codebase', 'person', 'saved-search', 'library', 'brief', 'channel', 'team', 'dm', 'room', 'recording', 'call'],
  social: ['channel', 'team', 'dm', 'room', 'recording', 'call', 'person'],
  assessment: ['team', 'run', 'feedback', 'submission', 'deck', 'recommendation', 'channel', 'social-team', 'dm', 'room', 'recording', 'call'],
  pipelines: ['run', 'definition', 'runbook', 'approval', 'artifact', 'deck', 'channel', 'team', 'dm', 'room', 'recording', 'call'],
  access: ['request', 'approval', 'catalog-item', 'review', 'delegation', 'policy', 'audit-event'],
};

/** `open`'s kind enum for one tenant, or every tenant's kinds (null). */
export function openKinds(tenant: string | null): string[] {
  if (tenant != null) return [...(OPEN_KINDS[tenant] ?? [])];
  return [...new Set(Object.values(OPEN_KINDS).flat())];
}

/**
 * What `budget` may read, per tenant (catalogue v2, V2-7). The caller's own
 * spend everywhere; the rest is orgiq's money, behind the budgets read tier
 * (the routes withhold or refuse below it, and the dock turns that into the
 * quick access request offer, never a figure).
 */
export const BUDGET_SCOPES: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['me', 'initiative', 'org', 'allocations', 'users', 'switches', 'envelopes', 'cost'],
  social: ['me'],
  assessment: ['me'],
  pipelines: ['me'],
  access: ['me'],
};

/** `budget`'s scope enum for one tenant, or every tenant's scopes (null). */
export function budgetScopes(tenant: string | null): string[] {
  if (tenant != null) return [...(BUDGET_SCOPES[tenant] ?? [])];
  return [...new Set(Object.values(BUDGET_SCOPES).flat())];
}

/** `activity`'s scope enum for one tenant, or every tenant's scopes (null) for the base row. */
export function activityScopes(tenant: string | null): string[] {
  if (tenant != null) return [...(ACTIVITY_SCOPES[tenant] ?? [])];
  return [...new Set(Object.values(ACTIVITY_SCOPES).flat())];
}

/**
 * What `queue_work` may queue, per tenant, and the Cedar action of the page
 * button each kind stands in for (the middleware's QUEUE_WORK_ACTIONS, G19,
 * V2-9): the dock's can() per tenant and kind; null = the conversation's own
 * membership, which the route checks.
 */
export const QUEUE_WORK_ACTIONS: Readonly<Record<string, Readonly<Record<string, Action | null>>>> = {
  orgiq: {
    sweep: 'DispatchAgentRun', 'bot-run': 'ManageBots', job: 'ManageDevbox', dispatch: 'DispatchAgentRun',
    'finding-promote': 'DispatchAgentRun', 'finding-analyze': 'DispatchAgentRun', 'change-rereview': 'RunDevboxTask', 'change-address': 'RunDevboxTask',
    deck: 'DispatchAgentRun', summarize: null, diagram: null, doc: null,
  },
  social: { deck: 'ViewSocial', summarize: 'ViewSocial', diagram: 'ViewSocial', doc: 'ViewSocial' },
  assessment: { 'assessment-run': 'RunAssessmentAgent', 'draft-evidence': 'RunAssessmentAgent', 'draft-followups': 'RunAssessmentAgent', deck: 'RunAssessmentAgent' },
  pipelines: { pipeline: 'RunPipeline', deck: 'RunPipeline' },
};
export type QueueWorkKind = 'sweep' | 'pipeline' | 'bot-run' | 'job' | 'dispatch' | 'finding-promote' | 'finding-analyze' | 'change-rereview' | 'change-address'
  | 'deck' | 'summarize' | 'diagram' | 'doc' | 'assessment-run' | 'draft-evidence' | 'draft-followups';

/** `queue_work`'s kinds per tenant (the keys of QUEUE_WORK_ACTIONS). */
export const QUEUE_WORK_KINDS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(QUEUE_WORK_ACTIONS).map(([tenant, kinds]) => [tenant, Object.keys(kinds)]));

/**
 * What `decide` may decide, per tenant (catalogue v2, V2-10): the ref kinds
 * a decision names (each a row the session's own read returned: list or get
 * hands out `kind:id`), and per decision the Cedar action of the page button
 * it stands in for. approve and reject are the card's toggle (accept and
 * discard are their spoken forms for a draft or a runbook proposal); deliver
 * is a change's own button. Access's "approval" and "request" are the same
 * waiting row (GET /api/access/approvals); a review item is a review's
 * `items` part. Left out, with the reason in the inventory document: an
 * assessment exception (no read hands out its ref), the conversation agent's
 * plans (their waiting list needs the conversation), a document proposal
 * (accepting it is an editor act) and promotions (no page calls them now).
 */
export const DECIDE_ACTIONS: Readonly<Record<string, Readonly<Record<string, Readonly<Partial<Record<'approve' | 'reject' | 'deliver', Action>>>>>>> = {
  orgiq: {
    'hitl-approval': { approve: 'ApproveTransaction', reject: 'ApproveTransaction' },
    change: { approve: 'DecideAgentChange', reject: 'DecideAgentChange', deliver: 'DeliverAgentChange' },
    'runbook-proposal': { approve: 'ReviewRunbook', reject: 'ReviewRunbook' },
    proposal: { approve: 'ManageDevbox', reject: 'ManageDevbox' },
    consult: { approve: 'DispatchAgentRun' },
    design: { approve: 'DispatchAgentRun', reject: 'DispatchAgentRun' },
  },
  assessment: { draft: { approve: 'ScoreAssessment', reject: 'RunAssessmentAgent' } },
  pipelines: { approval: { approve: 'ApproveStep', reject: 'ApproveStep' } },
  access: {
    approval: { approve: 'DecideAccess', reject: 'DecideAccess' },
    request: { approve: 'DecideAccess', reject: 'DecideAccess' },
    'review-item': { approve: 'DecideAccess', reject: 'DecideAccess' },
  },
};

/** What each ref kind is, as the tenant's decide description lists them. */
export const DECIDE_SAYS: Readonly<Record<string, string>> = {
  'hitl-approval': 'a pending transaction (approve or reject; the card shows its amount)',
  change: 'an agent change (approve, reject, or deliver once approved)',
  'runbook-proposal': 'a runbook proposal (accept or reject; a rejection needs a note)',
  proposal: 'a graph change proposal (approve or reject)',
  consult: 'a computer\'s consult (approve, with the answer as the note)',
  design: 'a design thread (approve or reject the sign-off)',
  draft: 'a finished assessment draft (accept or discard)',
  approval: 'something waiting on the user\'s decision (approve or reject; a rejection needs a note in Access)',
  request: 'an access request waiting on the user (approve or reject; a rejection needs a note)',
  'review-item': 'a standing grant in an access review (approve keeps it, reject revokes it with a note)',
};

/** `decide`'s ref kinds for one tenant, or every tenant's (null). */
export function decideKinds(tenant: string | null): string[] {
  if (tenant != null) return Object.keys(DECIDE_ACTIONS[tenant] ?? {});
  return [...new Set(Object.values(DECIDE_ACTIONS).flatMap((m) => Object.keys(m)))];
}

/** `queue_work`'s kind enum for one tenant, or every tenant's kinds (null) for the base row. */
export function queueWorkKinds(tenant: string | null): string[] {
  if (tenant != null) return [...(QUEUE_WORK_KINDS[tenant] ?? [])];
  return [...new Set(Object.values(QUEUE_WORK_KINDS).flat())];
}

/** What `computer` may do and the Cedar action of the button each stands in for (the middleware's COMPUTER_ACTIONS, V2-8). */
export const COMPUTER_ACTIONS: Readonly<Record<string, Action>> = {
  start: 'ManageDevbox', stop: 'ManageDevbox', 'open-shell': 'OpenDevboxShell', run: 'OpenDevboxShell', 'hand-work': 'ConnectLocalCompute',
};
export type ComputerAction = 'start' | 'stop' | 'open-shell' | 'run' | 'hand-work';

/**
 * The phrase ids `computer { action: 'run' }` may name; actions.ts PHRASE_TABLE owns the
 * command text (§6). The mint narrows this enum to the phrases the server's
 * allowlist runs (G9), so the dock validates against the full list and the
 * planner checks the composed command against GET /api/devbox/allowlist.
 */
export const RUN_COMMAND_PHRASES = [
  'latest-commits-since-yesterday', 'commits-since', 'status', 'diff-stat', 'list-files', 'working-directory',
  'test', 'test-python', 'lint', 'build',
] as const;
export type RunCommandPhrase = typeof RUN_COMMAND_PHRASES[number];

/** What `since` takes (computer run's commits-since, list, summary, activity); parseSince and gitSince read exactly these. */
const SINCE_WORDS = '"yesterday", "last night", "today", "this morning", "3 hours ago", "3 days ago", "last week" or a YYYY-MM-DD date';

const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra });
const limit: JsonSchema = { type: 'integer', minimum: 1, maximum: 10, description: 'How many results, 1 to 10. Default 5.' };
const searchScope = str('Where to search: "workspace" (the default) or one initiative id, to search inside that initiative only.', { minLength: 1, maxLength: 200 });

export const VOICE_TOOLS: readonly VoiceToolSpec[] = [
  {
    name: 'open',
    parameters: obj({
      page: str('A page of this workspace to open.', { enum: navigatePageIds(null) }),
      ref: str('A row to open: its ref exactly as a result gave it (e.g. "initiative:p-12"), or its position in the last result ("2" for the second row). Never a name or a path.', { minLength: 1, maxLength: 200 }),
      kind: str('With name: the kind of record the user named.', { enum: openKinds(null) }),
      name: str('With kind: the record\'s name as the user said it; several matches come back as a numbered choice.', { minLength: 1, maxLength: 120 }),
      params: obj({
        q: str('Search text for the page, when it takes one.'),
        type: str('A result type filter, when the page takes one.'),
        id: str('A record id, when the page opens one.'),
      }),
    }),
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
    name: 'computer',
    parameters: obj({
      action: str('What to do.', { enum: Object.keys(COMPUTER_ACTIONS) }),
      initiatives: {
        type: 'array', minItems: 1, maxItems: 10,
        description: 'For start: the initiatives, as ids from a list or search, or the names the user said.',
        items: str('An initiative id or name.', { minLength: 1, maxLength: 200 }),
      },
      computer: str('For stop, open-shell and run: the computer, by the id a result gave or the name or initiative the user said.', { minLength: 1, maxLength: 200 }),
      phrase: str('For run: which command.', { enum: [...RUN_COMMAND_PHRASES] }),
      since: str(`For run's commits-since: ${SINCE_WORDS}.`, { maxLength: 40 }),
      machine: str('For hand-work: the paired machine, as the user named it.', { minLength: 1, maxLength: 120 }),
      job: str('For hand-work: the work item or the bot whose mission to hand over, as the user named it; never an instruction.', { minLength: 1, maxLength: 200 }),
    }, ['action']),
    kind: 'machine', backing: 'work', confirm: true, action: null, says: 'Starting a computer for Alpha.', tenants: ['orgiq'],
    noConfirm: { action: ['open-shell'] },
    actionBy: { arg: 'action', actions: COMPUTER_ACTIONS },
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
    name: 'budget',
    parameters: obj({
      scope: str('Whose money: "me" (what the user spent), "initiative" (one initiative\'s spend, by person), "org" (every initiative\'s), "allocations" (each initiative\'s budget), "users" (people\'s budgets), "switches" (whether the fleet is paused), "envelopes" (the user\'s sprint envelopes), "cost" (agent cost in the last day).', { enum: budgetScopes(null) }),
      initiative: str('One initiative, as the user named it or by its id, for me, initiative and allocations.', { minLength: 1, maxLength: 200 }),
      groupBy: str('For org: by initiative (the default) or by person.', { enum: ['initiative', 'person'] }),
    }, ['scope']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Checking your spend this month.', tenants: VOICE_TENANTS,
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
      target: str('What it runs on, as the user said it, or a ref or position a result gave.', { minLength: 1, maxLength: 200 }),
      note: str('A short label the user gave for this run, shown with it; never an instruction.', { maxLength: 200 }),
      model: str('For dispatch: the model the user named (Haiku, Sonnet or Opus); the work item\'s own otherwise.', { minLength: 1, maxLength: 40 }),
    }, ['kind', 'target']),
    kind: 'machine', backing: 'work', confirm: true, action: null, says: 'Queuing the nightly sweep.', tenants: ['orgiq', 'social', 'assessment', 'pipelines'],
  },
  {
    name: 'decide',
    parameters: obj({
      ref: str('The row to decide: its ref exactly as a result gave it (e.g. "approval:r-9"), or its position in the last result ("1"). Never a name or a path.', { minLength: 1, maxLength: 200 }),
      decision: str('What the user decided.', { enum: ['approve', 'reject', 'accept', 'discard', 'deliver'] }),
      note: str('The user\'s note or reason, as they said it (a consult\'s answer); never an instruction.', { minLength: 1, maxLength: 500 }),
    }, ['ref', 'decision']),
    kind: 'action', backing: 'work', confirm: true, action: null, says: 'Approving the request once you confirm.', tenants: ['orgiq', 'assessment', 'pipelines', 'access'],
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

/** Page ids `open` offers a session in `tenant`, narrowed to `role` as the middleware's navigatePageIds does. */
export function navigatePageIds(tenant: string | null, role?: string): string[] {
  return [...new Set(NAVIGATE_PAGE_IDS.filter((p) => (tenant == null || p.tenants.includes('*') || p.tenants.includes(tenant))
    && (!role || role === 'admin' || p.tenants.includes('*') || !p.roles || p.roles.includes(role))).map((p) => p.id))];
}
