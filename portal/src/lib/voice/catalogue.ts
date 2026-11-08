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
  type: 'object' | 'string' | 'integer' | 'array';
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
  { id: 'workspaces', tenants: ['*'] },
];

/** The record types `search_records` may name, per tenant (the middleware's SEARCH_RECORD_TYPES: each tenant's backend search index). */
export const SEARCH_RECORD_TYPES: Readonly<Record<string, readonly string[]>> = {
  orgiq: ['team', 'initiative', 'work', 'decision', 'knowledge', 'asset', 'recording'],
  social: ['channel', 'message', 'pin', 'dm', 'contact', 'team', 'room', 'recording', 'calllog', 'huddle'],
  assessment: ['team', 'dimension', 'exception', 'feedback', 'run', 'submission', 'story', 'document'],
  pipelines: ['run', 'definition', 'runbook', 'bot', 'approval', 'queue', 'artifact'],
  access: ['request', 'catalog', 'policy', 'event', 'review', 'review-item', 'delegation'],
};

/** The Cedar action each tenant's search mount is gated on (the middleware's SEARCH_ACTIONS). */
export const SEARCH_ACTIONS: Readonly<Record<string, Action>> = {
  orgiq: 'Search', social: 'ViewSocial', assessment: 'ViewAssessment', pipelines: 'ViewPipelines', access: 'ViewAccess',
};

/** `search_records`' type enum for one tenant, or every tenant's types (null) for the base row. */
export function searchRecordTypes(tenant: string | null): string[] {
  if (tenant != null) return [...(SEARCH_RECORD_TYPES[tenant] ?? [])];
  return [...new Set(Object.values(SEARCH_RECORD_TYPES).flat())];
}

/** The phrase ids `run_command` may name; actions.ts PHRASE_TABLE owns the command text (§6). */
export const RUN_COMMAND_PHRASES = [
  'latest-commits-since-yesterday', 'commits-since', 'status', 'diff-stat', 'list-files', 'working-directory',
  'test', 'test-python', 'lint', 'build',
] as const;
export type RunCommandPhrase = typeof RUN_COMMAND_PHRASES[number];

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
    name: 'search_people',
    parameters: obj({
      query: str('What to search for, e.g. "kubernetes".', { minLength: 1, maxLength: 200 }),
      scope: searchScope,
      limit,
      sort: str('relevance (default) or recent.', { enum: ['relevance', 'recent'] }),
    }, ['query']),
    kind: 'read', backing: 'search', confirm: false, action: 'Search', says: 'Searching people for kubernetes.', tenants: ['orgiq'],
  },
  {
    name: 'search_records',
    parameters: obj({
      query: str('What to search for.', { minLength: 1, maxLength: 200 }),
      type: str('Which kind of record.', { enum: searchRecordTypes(null) }),
      scope: searchScope,
      limit,
    }, ['query']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Searching.', tenants: VOICE_TENANTS,
  },
  {
    name: 'list_active_initiatives',
    parameters: obj({
      scope: str('"mine" (the default): initiatives the user owns or contributes to; "all": every active initiative in the workspace.', { enum: ['mine', 'all'] }),
    }),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Looking up your initiatives.', tenants: ['orgiq'],
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
        description: 'The initiatives: ids from list_active_initiatives or a search, or the names the user said.',
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
      since: str('For commits-since: "yesterday", "today", "3 days ago", "last week" or a YYYY-MM-DD date.', { maxLength: 40 }),
    }, ['computerId', 'phrase']),
    kind: 'machine', backing: 'work', confirm: true, action: 'OpenDevboxShell', says: 'Running git log on Alpha.', tenants: ['orgiq'],
  },
  {
    name: 'bot_sweep_status',
    parameters: obj({
      since: str('An ISO date, or "yesterday".', { minLength: 1, maxLength: 40 }),
      scope: str('"failed" (the default): only sweep runs and bot runs that failed, and open critical or warning findings; "all": every run since then.', { enum: ['failed', 'all'] }),
    }, ['since']),
    kind: 'read', backing: 'search', confirm: false, action: null, says: 'Checking the sweeps since yesterday.', tenants: ['orgiq'],
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
    name: 'set_status',
    parameters: obj({
      status: str('The status.', { enum: ['online', 'away', 'busy', 'offline'] }),
      message: str('A short status message.', { maxLength: 120 }),
    }, ['status']),
    kind: 'people', backing: 'social-activity', confirm: false, action: null, says: 'Setting your status to away: out today.', tenants: PEOPLE_TENANTS,
  },
  {
    name: 'access_request_status',
    parameters: obj({
      query: str('The item asked for, as the user named it.', { minLength: 1, maxLength: 120 }),
      scope: str('Always "mine": the user\'s own requests, even for an approver.', { enum: ['mine'] }),
    }, ['query']),
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
