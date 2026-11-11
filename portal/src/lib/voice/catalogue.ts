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
  /**
   * Who may answer the card (G40): 'voice' (a spoken "confirm" decides it, as a click does) or 'click' (only the
   * button: computer, decide (an answer to an agent's question too), an access request); `clickFor` names argument values that make a voice tool
   * click-only. `sayToConfirm` is the verb the voice asks with ("Say confirm to send").
   */
  confirmBy?: 'voice' | 'click';
  clickFor?: Readonly<Record<string, readonly string[]>>;
  sayToConfirm?: string;
  /** The gate per argument value where `action` is null (computer: the button each action stands in for). */
  actionBy?: { arg: string; actions: Readonly<Record<string, Action>> };
}

export const VOICE_TENANTS = ['orgiq', 'social', 'assessment', 'pipelines', 'access'] as const;
/** Where the machine and people tools reach (the middleware's PEOPLE_TENANTS); the other tenants get reads and navigation only. */
const PEOPLE_TENANTS = ['orgiq', 'social'] as const;
/** Where `activity` reads: Social itself, and the tenants that embed its plane (tenants/manifest.json; V2-13). */
const ACTIVITY_TENANTS = ['orgiq', 'social', 'assessment', 'pipelines'] as const;

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
  { id: 'system-logging', tenants: ['orgiq'] },
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
  { id: 'definitions', tenants: ['pipelines'] },
  { id: 'workflows', tenants: ['pipelines'] },
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
  { id: 'system-logging', tenants: ['pipelines'] },
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
  // V2-13: where the Social plane is embedded (inventory §3): the plane's own index and the footer's roster.
  assessment: ['online', 'live-calls', 'missed-calls', 'messages', 'pins', 'recent'],
  pipelines: ['online', 'live-calls', 'missed-calls', 'messages', 'pins', 'recent'],
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
  orgiq: ['work', 'decisions', 'activity', 'documents', 'runs', 'brief', 'comments', 'criteria', 'history', 'steps', 'versions', 'applications', 'evaluations', 'evidence', 'members', 'transcript'],
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
  orgiq: ['sweeps', 'sprint', 'review', 'work', 'fleet', 'machines', 'health', 'ingest', 'today', 'unread', 'live'],
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
 * plans (their waiting list needs the conversation) and a document proposal
 * (accepting it is an editor act).
 */
export const DECIDE_ACTIONS: Readonly<Record<string, Readonly<Record<string, Readonly<Partial<Record<'approve' | 'reject' | 'deliver', Action>>>>>>> = {
  orgiq: {
    'hitl-approval': { approve: 'ApproveTransaction', reject: 'ApproveTransaction' },
    change: { approve: 'DecideAgentChange', reject: 'DecideAgentChange', deliver: 'DeliverAgentChange' },
    'runbook-proposal': { approve: 'ReviewRunbook', reject: 'ReviewRunbook' },
    proposal: { approve: 'ManageDevbox', reject: 'ManageDevbox' },
    consult: { approve: 'DispatchAgentRun' },
    design: { approve: 'DispatchAgentRun', reject: 'DispatchAgentRun' },
    // G54: resolve is approve, reject is reject; the route scopes it to the decider or the initiative's owner.
    decision: { approve: 'DecideDecision', reject: 'DecideDecision' },
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
  consult: 'an agent\'s question (approve, the user\'s answer as the note; only a click sends it)',
  design: 'a design thread (approve or reject the sign-off)',
  decision: 'a waiting decision (resolve with an option, or the outcome and why as note; or reject)',
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

/**
 * What `create` may create, per tenant (catalogue v2, V2-11), and the Cedar
 * action of the form's submit button each kind stands in for; and the
 * fields each kind takes (one set per kind: anything else is refused).
 * Left out, with the reason in the inventory document: an assessment
 * follow-up (no page posts one), a document proposal and a review request
 * (editor acts on a document's anchors and reviewers).
 */
export const CREATE_ACTIONS: Readonly<Record<string, Readonly<Record<string, Action | null>>>> = {
  // meeting (G25): the initiative's huddle room and a time, said in the thread it answers; access-request (G27): the
  // Social plane's own request item through the quick route (the route checks it is that item).
  // document, whiteboard (G55/G56): a page or a board in an initiative, the Docs tab's New menu; no dock action of their own:
  // the route checks ViewWorkItems and the initiative's own people, and its list read's canWrite says so before the card.
  // deck: queue_work's deck by another name.
  orgiq: { 'work-item': 'DispatchAgentRun', comment: null, 'saved-search': 'Search', sprint: 'ManageSprints', meeting: null, 'access-request': null, document: null, whiteboard: null, deck: 'DispatchAgentRun' },
  social: { channel: 'ManageChannels', team: 'ManageTeams', room: 'ManageChannels' },
  access: { 'access-request': 'RequestAccess', delegation: 'DecideAccess' },
};

/** Each create kind's field set: [required, optional]. */
export const CREATE_FIELDS: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
  'work-item': [['title'], ['initiative', 'type']],
  comment: [['on', 'text'], []],
  'saved-search': [['name', 'query'], []],
  sprint: [['initiative', 'name', 'startsOn', 'endsOn'], []],
  channel: [['name'], ['description', 'privacy']],
  team: [['name'], ['description', 'privacy']],
  room: [['name'], ['description', 'privacy']],
  'access-request': [['item', 'justification'], ['duration']],
  meeting: [['initiative', 'time'], ['thread']],
  delegation: [['delegate', 'window', 'reason'], []],
  document: [[], ['initiative', 'title']],
  whiteboard: [[], ['initiative', 'title']],
  deck: [[], ['initiative', 'focus']],
};

/**
 * What `update` may change, per tenant: the ref kind, the one field it
 * takes, and the Cedar action of the button that changes it. A work item's
 * status, a bot paused or resumed, a finding dismissed, a job reviewed or
 * requeued, a channel joined (PostMessage) or left, a DM read, an
 * assessment or pipeline run stopped, a follow-up resolved or dismissed,
 * the program report published (the fixed ref `report:program`), an access
 * request withdrawn and a delegation ended. Left out: pins (no read hands
 * out a message's ref), posting a finished summary or deck (the route hands
 * back a message the page then sends itself), a team's mute (the route has
 * only a favourite) and withdrawing a runbook proposal (no page offers it).
 */
export const UPDATE_ACTIONS: Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, Action | null>>>>>> = {
  orgiq: {
    'work-item': { status: 'DispatchAgentRun', assignee: 'DispatchAgentRun', sprint: 'ManageSprints' }, bot: { paused: 'ManageBots' }, finding: { status: 'ManageDevbox' },
    job: { reviewed: 'ManageDevbox', requeued: 'ManageDevbox' }, channel: { member: 'PostMessage' }, dm: { read: null },
  },
  social: { channel: { member: 'PostMessage' }, dm: { read: 'ViewSocial' } },
  assessment: { run: { status: 'RunAssessmentAgent' }, feedback: { status: 'ScoreAssessment' }, report: { publish: 'PublishReport' } },
  pipelines: { run: { status: 'CancelRun' } },
  access: { request: { status: 'ViewAccess' }, delegation: { status: 'DecideAccess' } },
};

/** `create`'s kinds for one tenant, or every tenant's (null). */
export function createKinds(tenant: string | null): string[] {
  if (tenant != null) return Object.keys(CREATE_ACTIONS[tenant] ?? {});
  return [...new Set(Object.values(CREATE_ACTIONS).flatMap((m) => Object.keys(m)))];
}

/** `update`'s ref kinds for one tenant, or every tenant's (null). */
export function updateKinds(tenant: string | null): string[] {
  if (tenant != null) return Object.keys(UPDATE_ACTIONS[tenant] ?? {});
  return [...new Set(Object.values(UPDATE_ACTIONS).flatMap((m) => Object.keys(m)))];
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

// What `since` takes (computer run's commits-since, list, summary, activity) is said once, in the middleware's
// delegationInstructions; parseSince and gitSince read exactly those words.
const obj = (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema =>
  ({ type: 'object', properties, required, additionalProperties: false });
const str = (description: string, extra: Partial<JsonSchema> = {}): JsonSchema => ({ type: 'string', description, ...extra });
const limit: JsonSchema = { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5.' };

/** G33: list, search and get hand the model a count, three rows and `more` unless the user asked for everything. */
const detail: JsonSchema = { type: 'boolean', description: 'True only when the user asked for every row.' };
const searchScope = str('"workspace" (default) or one initiative id to search inside.', { minLength: 1, maxLength: 200 });

export const VOICE_TOOLS: readonly VoiceToolSpec[] = [
  {
    name: 'open',
    parameters: obj({
      page: str('A page of this workspace to open.', { enum: navigatePageIds(null) }),
      ref: str('A row to open: a ref or a position in the last result.', { minLength: 1, maxLength: 200 }),
      kind: str('With name: the kind of record the user named.', { enum: openKinds(null) }),
      name: str('With kind: the record\'s name.', { minLength: 1, maxLength: 120 }),
      scope: str('"this-page": the ref or name is one of the rows the page in view shows; kind is then optional. With tab alone: a tab of that page.', { enum: ['this-page'] }),
      tab: str('A tab the page context lists ("decisions"): of the page in view with scope "this-page", else of the ref\'s record.', { minLength: 1, maxLength: 40 }),
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
      type: str('Which kind of record (knowledge: runbooks and ADRs).', { enum: searchRecordTypes(null) }),
      scope: searchScope,
      sort: str('relevance (default) or recent.', { enum: ['relevance', 'recent'] }),
      limit,
      answer: { type: 'boolean', description: 'True when the question wants one fact (who, how many, which): answered from the index.' },
      detail,
    }, ['query']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Searching for the Kubernetes experts.', tenants: VOICE_TENANTS,
  },
  {
    name: 'list',
    parameters: obj({
      kind: str('Which kind of record.', { enum: listKinds(null) }),
      filter: obj({
        q: str('Words the name should contain.', { minLength: 1, maxLength: 120 }),
        status: str('A status, as the page shows it ("blocked" for work items; "waiting" or "decided" for decisions).', { minLength: 1, maxLength: 40 }),
        who: str('work-item: the assignee ("me" for the user); decision: "me", what waits on the user.', { minLength: 1, maxLength: 120 }),
        sprint: str('work-item: "this", "last", "next" or a sprint name.', { minLength: 1, maxLength: 80 }),
        scope: str('"mine" (the user\'s own, where the kind takes it), "all" (everything the user can read: any kind), or "reports" (the user\'s reports\' access requests).', { enum: ['mine', 'all', 'reports'] }),
        since: str('Only records since a time.', { minLength: 1, maxLength: 40 }),
      }),
      scope: str('"this-page": the rows the page in view shows, in its order, instead of reading again; filter and limit still apply.', { enum: ['this-page'] }),
      limit,
      detail,
    }, ['kind']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Looking up your initiatives.', tenants: VOICE_TENANTS,
  },
  {
    name: 'get',
    parameters: obj({
      ref: str('The record: a ref or a position in the last result.', { minLength: 1, maxLength: 200 }),
      part: str('One part instead of the summary, where the kind has it.', { enum: getParts(null) }),
      detail,
    }, ['ref']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Reading that initiative.', tenants: VOICE_TENANTS,
  },
  {
    name: 'computer',
    parameters: obj({
      action: str('What to do.', { enum: Object.keys(COMPUTER_ACTIONS) }),
      initiatives: {
        type: 'array', minItems: 1, maxItems: 10,
        description: 'For start: the initiatives, as ids or names.',
        items: str('An initiative id or name.', { minLength: 1, maxLength: 200 }),
      },
      computer: str('For stop, open-shell and run: the computer, by id, name or initiative.', { minLength: 1, maxLength: 200 }),
      phrase: str('For run: which command.', { enum: [...RUN_COMMAND_PHRASES] }),
      since: str('For run\'s commits-since: a time.', { maxLength: 40 }),
      machine: str('For hand-work: the paired machine.', { minLength: 1, maxLength: 120 }),
      job: str('For hand-work: the work item or bot whose mission to hand over.', { minLength: 1, maxLength: 200 }),
    }, ['action']),
    kind: 'machine', backing: 'work', confirm: true, confirmBy: 'click', sayToConfirm: 'go ahead', action: null, says: 'Starting a computer for Alpha.', tenants: ['orgiq'],
    noConfirm: { action: ['open-shell'] },
    actionBy: { arg: 'action', actions: COMPUTER_ACTIONS },
  },
  {
    name: 'summary',
    parameters: obj({
      kind: str('Which aggregate: "sweeps" (sweep and bot runs that failed, open findings), "sprint" (the sprint in view or the user\'s: left, done, blocked on what), "review" (what needs the user: agent questions, jobs, proposals, unread notifications), "work" (the work queue), "fleet" (the computers), "machines" (paired machines), "health" (agent runs in the last 24 hours), "ingest", "today", "unread" (discussions), "live" (who is online, in a call), "pipelines" (failed runs, dead letters), "rollup" (the assessment program), "access".', { enum: summaryKinds(null) }),
      since: str('Since when, for sweeps, pipelines, machines and unread (default yesterday for sweeps and pipelines).', { minLength: 1, maxLength: 40 }),
    }, ['kind']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Checking the sweeps since yesterday.', tenants: VOICE_TENANTS,
  },
  {
    name: 'budget',
    parameters: obj({
      scope: str('Whose money: "me" (what the user spent), "initiative" (one initiative\'s spend, by person), "org" (every initiative\'s), "allocations" (each initiative\'s budget), "users" (people\'s budgets), "switches" (whether the fleet is paused), "envelopes" (sprint envelopes: the user\'s, or on an initiative), "cost" (agent cost in the last day).', { enum: budgetScopes(null) }),
      initiative: str('One initiative as the user named it, or "this-page", for me, initiative, allocations and envelopes.', { minLength: 1, maxLength: 200 }),
      groupBy: str('For org: by initiative (the default) or by person.', { enum: ['initiative', 'person'] }),
      period: str('For initiative and org: month (the default), 7d (this week) or 30d.', { enum: ['month', '7d', '30d'] }),
      sprint: str('For envelopes: "this", "last" or a sprint name.', { maxLength: 200 }),
    }, ['scope']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Checking your spend this month.', tenants: VOICE_TENANTS,
  },
  {
    name: 'activity',
    parameters: obj({
      scope: str('What to read: "online", "live-calls" (a call or huddle now), "missed-calls", "messages", "pins", "work" (what a person worked on, in Work) or "recent" (messages, pins, missed calls and, in Work, work items, since a time; yesterday by default).', { enum: activityScopes(null) }),
      since: str('Since when, for messages, pins, missed-calls, work and recent.', { minLength: 1, maxLength: 40 }),
      who: str('One person to narrow the read to ("what did Ada work on").', { minLength: 1, maxLength: 120 }),
    }, ['scope']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Checking who is on a call.', tenants: ACTIVITY_TENANTS,
  },
  {
    name: 'message',
    parameters: obj({
      target: obj({
        kind: str('Where it goes.', { enum: ['team', 'channel', 'dm'] }),
        name: str('The team, channel or person.', { minLength: 1, maxLength: 120 }),
      }, ['kind', 'name']),
      text: str('The message, exactly as dictated.', { minLength: 1, maxLength: 2000 }),
      thread: str('A reply instead: the inbound message\'s ref ("message:<id>"), in the same conversation; leave target out.', { minLength: 9, maxLength: 200 }),
      attach: str('A work item or initiative to share, read-only for 24 hours: its ref or position.', { minLength: 1, maxLength: 200 }),
    }, ['text']),
    kind: 'people', backing: 'social-activity', confirm: true, confirmBy: 'voice', sayToConfirm: 'send', action: 'PostMessage', says: "I'll post that to #platform once you confirm.", tenants: PEOPLE_TENANTS,
  },
  {
    name: 'call',
    parameters: obj({
      action: str('start a huddle (or ring a person), or join the live huddle there.', { enum: ['start', 'join'] }),
      target: obj({
        kind: str('Where the call is: a team, a channel, or one person (dm).', { enum: ['team', 'channel', 'dm'] }),
        name: str('The team, channel or person.', { minLength: 1, maxLength: 120 }),
      }, ['kind', 'name']),
    }, ['action']),
    kind: 'people', backing: 'social-activity', confirm: true, confirmBy: 'voice', sayToConfirm: 'start the call', action: 'StartCall', says: "I'll start a huddle in #platform once you confirm.", tenants: PEOPLE_TENANTS,
  },
  {
    name: 'set_status',
    parameters: obj({
      status: str('The status.', { enum: ['online', 'away', 'busy', 'offline'] }),
      message: str('A short status message.', { maxLength: 120 }),
    }, ['status']),
    kind: 'people', backing: 'social-activity', confirm: false, action: null, says: 'Setting your status to away: out today.', tenants: ['orgiq', 'social', 'assessment', 'pipelines'],
  },
  {
    name: 'queue_work',
    parameters: obj({
      kind: str('What to queue.', { enum: queueWorkKinds(null) }),
      target: str('What it runs on: the user\'s words, a ref or a position.', { minLength: 1, maxLength: 200 }),
      note: str('A short label the user gave for this run.', { maxLength: 200 }),
      model: str('For dispatch: the model the user named (Haiku, Sonnet or Opus); the work item\'s own otherwise.', { minLength: 1, maxLength: 40 }),
      rows: {
        type: 'array', minItems: 1, maxItems: 10,
        description: 'With scope "this-page": positions among the page\'s rows ("the top three" is [1, 2, 3]); target says what they are.',
        items: { type: 'integer', minimum: 1, maximum: 20 },
      },
      scope: str('"this-page": rows (or a position in target) are the page in view\'s rows; for deck with no rows, the record in view.', { enum: ['this-page'] }),
      focus: str('For deck: what it should cover, in the user\'s words ("progress this past sprint").', { minLength: 1, maxLength: 200 }),
    }, ['kind', 'target']),
    kind: 'machine', backing: 'work', confirm: true, confirmBy: 'voice', sayToConfirm: 'queue it', action: null, says: 'Queuing the nightly sweep.', tenants: ['orgiq', 'social', 'assessment', 'pipelines'],
  },
  {
    name: 'decide',
    parameters: obj({
      ref: str('The row to decide: a ref or a position in the last result.', { minLength: 1, maxLength: 200 }),
      decision: str('What the user decided (resolve is a decision\'s approve).', { enum: ['approve', 'reject', 'accept', 'discard', 'deliver', 'resolve'] }),
      note: str('The user\'s note or reason (a consult\'s answer, a decision\'s outcome and why).', { minLength: 1, maxLength: 500 }),
      scope: str('"this-page": a position in ref counts among the rows the page in view shows.', { enum: ['this-page'] }),
      option: str('A decision option, by number or label.', { minLength: 1, maxLength: 200 }),
    }, ['ref', 'decision']),
    kind: 'action', backing: 'work', confirm: true, confirmBy: 'click', sayToConfirm: 'record the decision', action: null, says: 'Approving the request once you confirm.', tenants: ['orgiq', 'assessment', 'pipelines', 'access'],
  },
  {
    name: 'create',
    parameters: obj({
      kind: str('What to create.', { enum: createKinds(null) }),
      fields: obj({
        initiative: str('By name or ref; "this-page" (or left out) is the one in view, except for a sprint or a meeting.', { minLength: 1, maxLength: 200 }),
        title: str('Its title (a document or whiteboard without one is "Untitled").', { minLength: 1, maxLength: 200 }),
        focus: str('What the deck should cover, in the user\'s words.', { minLength: 1, maxLength: 200 }),
        type: str('story (default), bug or epic.', { enum: ['story', 'bug', 'epic'] }),
        on: str('The work item it is on (ref or position).', { minLength: 1, maxLength: 200 }),
        text: str('The comment.', { minLength: 1, maxLength: 2000 }),
        name: str('Its name.', { minLength: 1, maxLength: 80 }),
        query: str('The search text.', { minLength: 1, maxLength: 200 }),
        startsOn: str('First day, YYYY-MM-DD.', { minLength: 10, maxLength: 10 }),
        endsOn: str('Last day, YYYY-MM-DD.', { minLength: 10, maxLength: 10 }),
        description: str('One line about it.', { minLength: 1, maxLength: 280 }),
        privacy: str('public (default) or private.', { enum: ['public', 'private'] }),
        item: str('The catalog item, by name or ref; outside Access, the requestItemId a refusal named.', { minLength: 1, maxLength: 200 }),
        justification: str('Why (in Access at least 20 characters).', { minLength: 1, maxLength: 2000 }),
        duration: str('How long (outside Access, a week when not said).', { enum: ['8h', '24h', '7d', '30d'] }),
        time: str('When ("5 pm", "tomorrow at 10").', { minLength: 1, maxLength: 40 }),
        thread: str('The inbound message it answers ("message:<id>"); the time and the room go back there.', { minLength: 9, maxLength: 200 }),
        delegate: str('Who decides for the user.', { minLength: 1, maxLength: 120 }),
        window: str('For how long.', { enum: ['1d', '3d', '7d', '14d'] }),
        reason: str('Why (at least 10 characters).', { minLength: 1, maxLength: 2000 }),
      }),
    }, ['kind', 'fields']),
    kind: 'action', backing: 'work', confirm: true, confirmBy: 'voice', clickFor: { kind: ['access-request'] }, sayToConfirm: 'create it', action: null, says: 'Creating that once you confirm.', tenants: ['orgiq', 'social', 'access'],
  },
  {
    name: 'update',
    parameters: obj({
      ref: str('The row to change: a ref, a position in the last result, a row the page in view shows (by name), or "report:program" for the assessment program report.', { minLength: 1, maxLength: 200 }),
      fields: obj({
        status: str('work-item: open, in_progress, in_review, done or cancelled; finding: dismissed; run: stopped (Assessment) or cancelled (Pipelines); feedback: resolved or dismissed; request: withdrawn; delegation: ended.', { enum: ['open', 'in_progress', 'in_review', 'done', 'cancelled', 'dismissed', 'stopped', 'resolved', 'withdrawn', 'ended'] }),
        assignee: str('Who owns it, by name ("me" for the user).', { minLength: 1, maxLength: 120 }),
        sprint: str('"this", "next", "none" or a sprint name.', { minLength: 1, maxLength: 80 }),
        response: str('feedback resolved: the response.', { minLength: 1, maxLength: 2000 }),
        paused: { type: 'boolean', description: 'true pauses it, false resumes it.' },
        reviewed: str('Accept or reject its result.', { enum: ['accept', 'reject'] }),
        requeued: { type: 'boolean', description: 'true runs a failed or cancelled job again.' },
        member: { type: 'boolean', description: 'true joins it, false leaves it.' },
        read: { type: 'boolean', description: 'true marks it read.' },
        publish: { type: 'boolean', description: 'true publishes the program report to its readers.' },
      }),
    }, ['ref', 'fields']),
    kind: 'action', backing: 'work', confirm: true, confirmBy: 'voice', clickFor: { 'fields.status': ['cancelled'] }, sayToConfirm: 'save it', action: null, says: 'Changing that once you confirm.', tenants: ['orgiq', 'social', 'assessment', 'pipelines', 'access'],
  },
  {
    name: 'access_request_status',
    parameters: obj({
      query: str('The item or the person; leave out to list them all.', { minLength: 1, maxLength: 120 }),
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
