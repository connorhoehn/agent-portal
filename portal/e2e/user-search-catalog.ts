// The user-search intent catalog (docs/user-search-intents.md). Each intent is a
// question a real person in one tenant × role asks, phrased several ways, with
// the answer the dev:mock seed holds (so a probe can tell right from wrong) and
// the entry points worth trying. `portal/e2e/user-search-probe.spec.ts` runs it.
//
// Expected answers are read from the fixtures under middleware/src/mock/
// (people.ts, initiatives.ts, decisions.ts, assessment.ts, social-*.ts,
// pipeline-*.ts, access-*.ts). Keys are search record keys (`type:id`); `text`
// is matched against whatever the surface returned (answer prose, rows,
// palette options). A match on ANY `text` pattern counts as the record reached.

export type Tenant = 'orgiq' | 'assessment' | 'social' | 'pipelines' | 'access';
export type SurfaceKind = 'search' | 'answer' | 'palette' | 'composer' | 'list-search' | 'api';

export interface Surface {
  kind: SurfaceKind;
  /** composer / list-search / palette: the page the probe starts on. */
  route?: string;
  /** list-search: the toolbar search box's placeholder. */
  placeholder?: string;
  /** composer: the bounded command a person who read the help popover would type. */
  grammar?: string;
  /** list-search: the box's test id when it has no stable placeholder (the box or an input inside it). */
  boxTestId?: string;
  /** list-search: read rows from the rail around the box instead of the page's main table. */
  railRows?: boolean;
  /** list-search: the keyword a person would type into a filter box (natural phrasings are tried too). */
  keyword?: string;
  /** api: a GET path ({q} is replaced by the encoded phrasing). Evidence only, never counted in the pass rate. */
  path?: string;
}

export interface Intent {
  id: string;
  tenant: Tenant;
  role: string;
  /** The seeded persona the probe clones for this role. */
  persona: string;
  intent: string;
  phrasings: string[];
  expected: {
    summary: string;
    /** search record keys that answer it (any one in the top 3 = supported). */
    keys?: string[];
    /** any match = the right record/fact is on screen. */
    text: RegExp[];
    /** the answer asserts something false. */
    wrong?: RegExp[];
    /** Set when the fact is computed from rows (a count, an absence, a live tally) so no single seed row carries `text`: says which rows it is computed from. */
    derived?: string;
  };
  /** Set when a clone cannot see the answer because the server keys it on the user id, not the person (reported apart from the pass rate). */
  cloneBlind?: string;
  /** The surface this intent belongs on, in the target design. */
  best: string;
  /** `best` as a surface kind (derived by `bestKindOf` unless set): the judge's zero-`wrong` rule reads it. */
  bestSurface: SurfaceKind;
  /** One of the tenant's top intents: a journey map under docs/journeys/maps/user-search/<tenant>/<role>/ walks it. */
  map?: boolean;
  surfaces: Surface[];
}

/**
 * The surface kind a `best` description names: its leading word (search, answer,
 * palette), a composer, or a list page's own search/filter. Where the target
 * surface is one the tenant does not offer yet, it is still named — the judge
 * then has no probe to grade on it, which is honest: nothing can be wrong there.
 */
export function bestKindOf(best: string): SurfaceKind {
  const b = best.toLowerCase();
  if (/^search\b/.test(b)) return 'search';
  if (/^answer\b/.test(b)) return 'answer';
  if (/^palette\b/.test(b)) return 'palette';
  if (/composer/.test(b)) return 'composer';
  if (/\b(list|catalog|audit|message|runbooks|requests|approvals|definitions|workspace document|recording content|feedback)\b.*\b(search|row|filter|history|list)\b|\blist search\b|\blist row\b/.test(b)) return 'list-search';
  if (/palette/.test(b)) return 'palette';
  return 'search';
}

/** Where the `best` prose names a list page rather than a surface word, the surface the probe tries there. */
const BEST_OVERRIDE: Record<string, SurfaceKind> = {
  'a-my-teams': 'composer', 'a-recording': 'palette', 'p-run-error': 'list-search', 'p-bot-last-run': 'list-search',
  'p-run-cost': 'composer', 'x-temporary': 'composer',
};

/** The top intents per tenant (five each) that journey maps walk (docs/user-search-goal.md judge 5). */
export const MAPPED = new Set([
  'o-expert-kubernetes', 'o-owner-initiative', 'o-team-members', 'o-adr', 'o-my-work',
  'a-team-lookup', 'a-team-lead', 'a-failed-runs', 'a-running', 'a-submission-by',
  's-find-person', 's-find-channel', 's-dm', 's-team-members', 's-room',
  'p-find-definition', 'p-dead-letter', 'p-needs-dry-run', 'p-failed-runs', 'p-bot-last-run',
  'x-find-entitlement', 'x-sod', 'x-review-undecided', 'x-waiting-on-me', 'x-who-approved',
]);

export const PERSONAS: Record<string, string> = {
  'orgiq:member': 'u-theo', 'orgiq:sme': 'u-nora', 'orgiq:program-owner': 'u-mia', 'orgiq:org-leader': 'u-vera', 'orgiq:hr-admin': 'u-hr',
  'assessment:assessor': 'u-asha', 'assessment:lead-assessor': 'u-jonas', 'assessment:program-lead': 'u-farah',
  'social:participant': 'u-sana', 'social:moderator': 'u-lena', 'social:community-admin': 'u-mira',
  'pipelines:author': 'u-ines', 'pipelines:operator': 'u-kofi', 'pipelines:pipeline-admin': 'u-dara',
  'access:requester': 'u-rhea', 'access:approver': 'u-omar', 'access:access-admin': 'u-priya',
};

const S = (kind: SurfaceKind, extra: Omit<Surface, 'kind'> = {}): Surface => ({ kind, ...extra });
const IQ = [S('search'), S('answer'), S('palette', { route: '/iq' })];
type Draft = Omit<Intent, 'persona' | 'tenant' | 'bestSurface'> & { bestSurface?: SurfaceKind };
const tenantOf = (tenant: Tenant) => (rows: Draft[]): Intent[] => rows.map((r) => ({
  ...r, tenant, persona: PERSONAS[`${tenant}:${r.role}`]!, bestSurface: r.bestSurface ?? BEST_OVERRIDE[r.id] ?? bestKindOf(r.best), ...(MAPPED.has(r.id) ? { map: true } : {}),
}));

// ── orgiq ────────────────────────────────────────────────────────────────────
const KUBE = ['p-007', 'p-009', 'p-014', 'p-020', 'p-022', 'p-056'];
const PLATFORM = ['p-001', 'p-002', 'p-004', 'p-005', 'p-006', 'p-007', 'p-008', 'p-009', 'p-011', 'p-013', 'p-014'];
export const ORGIQ = tenantOf('orgiq')([
  { id: 'o-expert-kubernetes', role: 'member', intent: 'Find people who know a skill (Kubernetes)',
    phrasings: ['who knows Kubernetes', 'Kubernetes experts', 'find someone who can help with k8s', 'people with Kubernetes skills'],
    expected: { summary: 'Marcus Müller, Arjun Shah, Grace Singh, Henry Hassan, Sarah Thompson, Hugo Lee (skills list Kubernetes)', keys: KUBE.map((p) => `person:${p}`),
      text: [/Marcus M(ü|u)ller|Arjun Shah|Grace Singh|Henry Hassan|Sarah Thompson|Hugo Lee/], wrong: [/Theo Chang[^.\n]{0,80}Kubernetes|James Thompson/] },
    best: 'search (People group ranked by skill) + answer citing them', surfaces: [...IQ, S('api', { path: '/api/graph/help?q={q}' })] },
  { id: 'o-expert-terraform', role: 'hr-admin', intent: 'Find people who know a skill (Terraform)',
    phrasings: ['who knows Terraform', 'Terraform skills', 'best person for terraform modules'],
    expected: { summary: 'Layla Hassan, Maria Johnson, Sienna Garcia, Diego Ortiz, Joy Chen, Tara Wright, Mateo Green (skills list Terraform)', keys: ['p-008', 'p-006', 'p-005', 'p-052', 'p-055', 'p-016', 'p-026'].map((p) => `person:${p}`),
      text: [/Layla Hassan|Maria Johnson|Sienna Garcia|Diego Ortiz|Joy Chen|Tara Wright|Mateo Green/], wrong: [/Theo Chang/] },
    best: 'search People', surfaces: [...IQ, S('api', { path: '/api/graph/help?q={q}' })] },
  { id: 'o-expert-rag', role: 'org-leader', intent: 'Rank the strongest people for a skill (RAG)',
    phrasings: ['who knows RAG best', 'top RAG experts', 'strongest retrieval-augmented generation people'],
    expected: { summary: 'Nina Rivera, Katya Petrov, Nora DaSilva, Noah Vasquez, Vikram Patel (RAG skill)', keys: ['p-047', 'p-042', 'p-004', 'p-045', 'p-046'].map((p) => `person:${p}`),
      text: [/Nina Rivera|Katya Petrov|Nora DaSilva|Noah Vasquez|Vikram Patel/] },
    best: 'answer (ranked by skill strength) + scores', surfaces: [...IQ, S('api', { path: '/api/scores/by-skill?skill=RAG' })] },
  { id: 'o-owner-initiative', role: 'member', intent: 'Who owns an initiative',
    phrasings: ['who owns the auth migration', 'Auth Migration owner', 'who is running auth migration?'],
    expected: { summary: 'Vera Green (p-002) owns p-auth-migration', keys: ['person:p-002', 'initiative:p-auth-migration'], text: [/Vera Green/] },
    best: 'answer (local answer: owners) + search initiative row', surfaces: IQ },
  { id: 'o-smes-initiative', role: 'member', intent: 'Who are the SMEs on an initiative',
    phrasings: ['who are the SMEs on auth migration', 'auth migration experts', 'who can help finish Auth Migration?'],
    expected: { summary: 'Simone Chang (p-051) and Nora DaSilva (p-004)', keys: ['person:p-051', 'person:p-004'], text: [/Simone Chang|Nora DaSilva/] },
    best: 'answer (owners/SMEs)', surfaces: IQ },
  { id: 'o-team-members', role: 'member', intent: 'Who is on a team / department',
    phrasings: ['who is on the platform team', 'Platform Engineering people', 'members of team platform'],
    expected: { summary: 'Platform Engineering (t-platform): Theo Chang, Vera Green, Nora DaSilva, Marcus Müller, Layla Hassan…', keys: PLATFORM.map((p) => `person:${p}`),
      text: [/Theo Chang|Vera Green|Nora DaSilva|Layla Hassan|Arjun Shah/] },
    best: 'search People filtered by department (team entity)', surfaces: IQ },
  { id: 'o-collaborators', role: 'org-leader', intent: 'People who worked with someone',
    phrasings: ['people who worked with Nora', 'Nora DaSilva collaborators', 'who works closely with Nora DaSilva'],
    expected: { summary: 'Caleb Turner (0.94), Owen Brooks (0.74), Arjun Shah (0.72), Maria Johnson (0.71)', keys: ['person:p-013', 'person:p-003', 'person:p-009', 'person:p-006'],
      text: [/Caleb Turner|Owen Brooks|Arjun Shah|Maria Johnson/] },
    best: 'answer + Connections graph from the person', surfaces: [...IQ, S('api', { path: '/api/graph/people/p-004' })] },
  { id: 'o-adr', role: 'member', intent: 'Find a decision / ADR',
    phrasings: ['find the ADR about Aurora vs Neptune', 'Aurora Neptune decision', 'why did we pick Aurora over Neptune'],
    expected: { summary: 'd-aurora "Adopt Aurora over Neptune" (cost + latency; decider Caleb Patel)', keys: ['decision:d-aurora'], text: [/Adopt Aurora over Neptune|Aurora over Neptune/] },
    best: 'search Decisions', surfaces: IQ },
  { id: 'o-who-decided', role: 'member', intent: 'Who made a decision',
    phrasings: ['who decided on self-hosted OTel collectors', 'who made the OpenTelemetry collector decision', 'decider for OTel collectors over vendor agents'],
    expected: { summary: 'Nora DaSilva decided d-otel-vendor', keys: ['decision:d-otel-vendor', 'person:p-004'], text: [/Nora DaSilva/] },
    best: 'answer (decision participants as edges)', surfaces: IQ },
  { id: 'o-open-decisions', role: 'program-owner', intent: 'Which decisions are still open / escalated',
    phrasings: ['which decisions are still open', 'unresolved decisions', 'escalated decisions'],
    expected: { summary: 'd-cognito-cutover (escalated, Auth Migration) and d-eval-judge-model (open, LLM platform)', keys: ['decision:d-cognito-cutover', 'decision:d-eval-judge-model'],
      text: [/Cutover order for legacy SSO tenants|Judge model for canary evaluation/] },
    best: 'search Decisions with a status filter', surfaces: IQ },
  { id: 'o-over-budget', role: 'org-leader', intent: 'What is over budget',
    phrasings: ["what's over budget", 'which initiatives are over budget', 'budget overruns this month'],
    expected: { summary: 'Local answer (budget): spend vs allocation per initiative; nothing over, Inference Platform has unbudgeted spend', text: [/over its \w+ allocation|over budget|RAG Knowledge Search|Inference Platform/i], wrong: [/locked for you/i] },
    best: 'answer (local answer: budget)', surfaces: IQ },
  { id: 'o-unbudgeted', role: 'org-leader', intent: 'Which initiatives have spend with no budget',
    phrasings: ['which initiatives have no budget', 'unbudgeted spend', 'initiatives without an allocation'],
    expected: { summary: 'Inference Platform (p-inference-platform) has no allocation', keys: ['initiative:p-inference-platform'], text: [/Inference Platform/], wrong: [/locked for you/i] },
    best: 'answer (local answer: budget)', surfaces: IQ },
  { id: 'o-blocked', role: 'program-owner', intent: "What's blocked",
    phrasings: ["what's blocked", 'which initiatives are blocked', 'blocked work on Observability'],
    expected: { summary: 'Observability Platform: wi-obs-e2-b4 "Stop duplicate alerts during a dependency outage" (Eli Garcia) and more', keys: ['work:wi-obs-e2-b4', 'initiative:p-observability'],
      text: [/Observability/] },
    best: 'answer (local answer: status/work)', surfaces: IQ },
  { id: 'o-behind-sprints', role: 'program-owner', intent: 'Which sprints are behind',
    phrasings: ['which sprints are behind', 'sprints at risk', 'are any sprints slipping'],
    expected: { summary: 'Local answer (sprints): sprints whose points-done share trails elapsed days by >25 points', text: [/Sprint \d|sprints? (are|is) behind/i] },
    best: 'answer (local answer: sprints)', surfaces: IQ },
  { id: 'o-what-changed', role: 'program-owner', intent: 'What changed on an initiative recently',
    phrasings: ['what changed on Observability Platform', 'recent activity on observability', 'Observability updates this week'],
    expected: { summary: 'Recent work/decisions on p-observability (no change-history endpoint exists; lastActivityAt only)', keys: ['initiative:p-observability'], text: [/Observability/] },
    best: 'answer over an initiative activity feed', surfaces: IQ },
  { id: 'o-initiative-status', role: 'org-leader', intent: 'Status of a named initiative',
    phrasings: ['status of LLM Application Platform', 'how is the LLM platform going', 'LLM platform progress'],
    expected: { summary: 'p-llm-platform (owner Nina Rivera, priority high)', keys: ['initiative:p-llm-platform'], text: [/LLM Application Platform/] },
    best: 'search initiative row + answer', surfaces: IQ },
  { id: 'o-failed-runs', role: 'sme', intent: 'Which agent runs failed this week',
    phrasings: ['which runs failed this week', 'failed runs', 'show failed runs'],
    expected: { summary: 'project run "Migrate the token verifier off the deprecated JWKS client" — npm test failed (2 days ago)', text: [/token verifier|JWKS/i] },
    best: 'composer on /iq/runs ("show failed runs")', surfaces: [S('search'), S('answer'), S('palette', { route: '/iq' }), S('composer', { route: '/iq/runs', grammar: 'show failed runs' })] },
  { id: 'o-my-work', role: 'sme', intent: 'My open work',
    phrasings: ['what am I working on', 'my open work items', 'work assigned to me'],
    expected: { summary: 'Nora DaSilva\'s items, e.g. wi-auth-e1-s1 "BFF authorization-code + PKCE flow" and wi-obs-e3 "Cost-aware telemetry"', keys: ['work:wi-auth-e1-s1', 'work:wi-obs-e3'],
      text: [/PKCE|Cost-aware telemetry/] },
    best: 'search with an implicit "me" (assignee = signed-in person) or /iq/work composer', surfaces: [...IQ, S('composer', { route: '/iq/work', grammar: 'search Nora' })] },
  { id: 'o-knowledge', role: 'member', intent: 'Find a how-to in the knowledge base',
    phrasings: ['how do I warm the Aurora Data API after idle', 'Aurora cold start', 'first Data API call fails'],
    expected: { summary: 'runbook rb-aurora-cold-start-retry "Wake a cold Aurora Data API and retry the first call"', keys: ['knowledge:rb-aurora-cold-start-retry'], text: [/Wake a cold Aurora|cold Aurora Data API/] },
    best: 'search Knowledge (runbooks)', surfaces: IQ },
  { id: 'o-single-threaded', role: 'org-leader', intent: 'Where are we single-threaded (bus factor)',
    phrasings: ['where are we single-threaded', 'bus factor risks', 'knowledge held by only one person'],
    expected: { summary: 'Open bus_factor findings (/iq/work/findings?sweep=bus_factor)', text: [/bus.?factor|single.?thread/i] },
    best: 'answer over findings + palette to /iq/work/findings', surfaces: [...IQ, S('composer', { route: '/iq/work/findings', grammar: 'search bus factor' })] },
  { id: 'o-expert-rust', role: 'sme', intent: 'Find a peer who knows a skill (Rust)',
    phrasings: ['who else knows Rust', 'Rust experts', 'people with Rust skills'],
    expected: { summary: 'Nora DaSilva, Maria Johnson, Sarah Thompson, Paolo Mancini, Ava Lee, Simone Chang, Ingrid Larsen (skills list Rust)', keys: ['p-004', 'p-006', 'p-022', 'p-049', 'p-050', 'p-051', 'p-053'].map((p) => `person:${p}`),
      text: [/Maria Johnson|Sarah Thompson|Paolo Mancini|Ava Lee|Simone Chang|Ingrid Larsen/] },
    best: 'search People', surfaces: IQ },
  { id: 'o-team-security', role: 'hr-admin', intent: 'Who is on a team (Security)',
    phrasings: ['who is on the security team', 'Security team members', 'people in Security'],
    expected: { summary: 'Security (t-security): Simone Chang, Diego Ortiz, Ingrid Larsen, Kevin Garcia, Joy Chen', keys: ['p-051', 'p-052', 'p-053', 'p-054', 'p-055'].map((p) => `person:${p}`),
      text: [/Simone Chang|Diego Ortiz|Ingrid Larsen|Kevin Garcia|Joy Chen/] },
    best: 'search People filtered by team (team entity)', surfaces: IQ },
  { id: 'o-person-lookup', role: 'hr-admin', intent: 'Find a person by name',
    phrasings: ['Nora DaSilva', 'find Nora DaSilva', 'who is Nora DaSilva'],
    expected: { summary: 'person:p-004 Nora DaSilva, Senior Engineer, Platform Engineering', keys: ['person:p-004'], text: [/Nora DaSilva/] },
    best: 'search People', surfaces: IQ },
]);

// ── assessment ───────────────────────────────────────────────────────────────
const AS_TEAMS = '/assessment/teams';
export const ASSESSMENT = tenantOf('assessment')([
  { id: 'a-team-lookup', role: 'assessor', intent: 'Find a team by name or id',
    phrasings: ['Northstar Payments', 'find team TEAM-001', 'open Northstar'],
    expected: { summary: 'TEAM-001 Northstar Payments (white glove, lead Priya Natarajan)', text: [/Northstar Payments/] },
    best: 'palette record jump + teams list', surfaces: [S('palette', { route: AS_TEAMS }), S('list-search', { route: AS_TEAMS, placeholder: 'Search by team name or ID…', keyword: 'Northstar' }), S('composer', { route: AS_TEAMS, grammar: 'open Northstar Payments' })] },
  { id: 'a-my-teams', role: 'assessor', intent: 'My teams',
    phrasings: ['my teams', "teams I'm on", 'which teams am I assigned to'],
    expected: { summary: 'TEAM-001 Northstar Payments (Asha is a contributor)', text: [/Northstar Payments/] },
    best: 'teams list "mine" filter', surfaces: [S('palette', { route: AS_TEAMS }), S('composer', { route: AS_TEAMS, grammar: 'show mine' })] },
  { id: 'a-team-lead', role: 'assessor', intent: 'Who leads a team',
    phrasings: ['who leads Data Platform', 'Data Platform lead', 'team lead for TEAM-004'],
    expected: { summary: 'Farah Osei leads TEAM-004 Data Platform', text: [/Farah Osei/] },
    best: 'teams list row (lead column)', surfaces: [S('palette', { route: AS_TEAMS }), S('list-search', { route: AS_TEAMS, placeholder: 'Search by team name or ID…', keyword: 'Data Platform' }), S('composer', { route: AS_TEAMS, grammar: 'search Data Platform' })] },
  { id: 'a-unassigned', role: 'program-lead', intent: 'Teams without a lead',
    phrasings: ['teams without a lead', 'unassigned teams', 'which teams have no lead'],
    expected: { summary: 'the teams whose lead column is empty — or, when every team has a lead (today\'s seed: 7 of 7), the statement that none is unassigned', text: [/Every team has an assessment lead|no assessment lead/i], derived: 'the team rows\' lead column: the answer counts the teams whose lead is empty, so "none" is a fact too' },
    best: 'teams composer filter', surfaces: [S('composer', { route: AS_TEAMS, grammar: 'show unassigned teams' }), S('palette', { route: AS_TEAMS })] },
  { id: 'a-white-glove', role: 'program-lead', intent: 'Teams in a motion',
    phrasings: ['white glove teams', 'show white glove teams', 'which teams are white-glove'],
    expected: { summary: 'TEAM-001 Northstar Payments and TEAM-004 Data Platform', text: [/Northstar Payments|Data Platform/] },
    best: 'teams composer filter', surfaces: [S('composer', { route: AS_TEAMS, grammar: 'show white glove teams' }), S('list-search', { route: AS_TEAMS, placeholder: 'Search by team name or ID…', keyword: 'white glove' })] },
  { id: 'a-below-target', role: 'lead-assessor', intent: 'Teams below the target level',
    phrasings: ['which teams are below target', 'teams under level 3', 'lowest scoring teams'],
    expected: { summary: 'TEAM-005 Notifications Service (level 1) and TEAM-003 Checkout Experience (level 2)', text: [/Notifications Service|Checkout Experience/] },
    best: 'reports composer ("show below target")', surfaces: [S('composer', { route: '/assessment/reports', grammar: 'show below target' }), S('list-search', { route: '/assessment/reports', placeholder: 'Search teams', keyword: 'below target' }), S('palette', { route: AS_TEAMS })] },
  { id: 'a-overclaim', role: 'program-lead', intent: 'Where self-claims exceed the score',
    phrasings: ['teams that over-claimed', 'self-claimed vs scored gaps', 'where was the cap applied'],
    expected: { summary: 'TEAM-002 Kubernetes Operator (claims 5, capped to 3); TEAM-001 dimension 1 (claim 5, scored 2)', text: [/Kubernetes Operator|Northstar/] },
    best: 'reports composer filter', surfaces: [S('composer', { route: '/assessment/reports', grammar: 'show capped' }), S('palette', { route: AS_TEAMS })] },
  { id: 'a-failed-runs', role: 'lead-assessor', intent: 'Which runs failed',
    phrasings: ['which runs failed this week', 'failed runs', 'show failed runs'],
    expected: { summary: 'suggest-confluence-content on Data Platform (ENG-DATA not linked); process-self-assessment on Notifications Service (row 9 team_id)', text: [/ENG-DATA|row 9|suggest-confluence-content|process-self-assessment/i] },
    best: 'runs composer ("show failed runs")', surfaces: [S('composer', { route: '/assessment/runs', grammar: 'show failed runs' }), S('palette', { route: AS_TEAMS }), S('api', { path: '/api/assessment/runs?status=failed' })] },
  { id: 'a-running', role: 'assessor', intent: "What's running now",
    phrasings: ["what's running now", 'in-progress runs', 'show running runs'],
    expected: { summary: 'score-dimensions on TEAM-003 Checkout Experience', text: [/score-dimensions|Checkout Experience/i] },
    best: 'runs composer', surfaces: [S('composer', { route: '/assessment/runs', grammar: 'show running runs' }), S('palette', { route: AS_TEAMS })] },
  { id: 'a-open-exceptions', role: 'lead-assessor', intent: 'Open exception reviews',
    phrasings: ['open exception reviews', 'pending N/A exceptions', 'which exceptions need approval'],
    expected: { summary: 'fb-f66662469029: TEAM-001 dimension 7 (Performance & Reliability Testing) N/A requested', text: [/Northstar|Performance/] },
    best: 'feedback composer ("show open")', surfaces: [S('composer', { route: '/assessment/feedback', grammar: 'show open' }), S('list-search', { route: '/assessment/feedback', placeholder: 'Search questions, dimensions or teams…', keyword: 'exception' })] },
  { id: 'a-who-approved-exception', role: 'program-lead', intent: 'Who approved an exception',
    phrasings: ['who approved the security testing exception for Northstar', 'who approved the TEAM-001 N/A', 'approver of Northstar dimension 6 exception'],
    expected: { summary: 'Jonas Lindqvist approved the TEAM-001 Northstar Payments dimension 6 (Security Testing) N/A exception', text: [/Jonas Lindqvist/] },
    best: 'team record (exceptions tab) reachable from search', surfaces: [S('composer', { route: '/assessment/feedback', grammar: 'search Northstar' }), S('palette', { route: AS_TEAMS })] },
  { id: 'a-answered', role: 'lead-assessor', intent: 'Find an answered question',
    phrasings: ['rolling deploys', 'what did Sam Okafor confirm', 'answered questions about deploys'],
    expected: { summary: 'fb-498e9969570b TEAM-003 dimension 2: "Rolling deploys, confirmed via interview with Sam Okafor."', text: [/Rolling deploys|Checkout Experience/] },
    best: 'feedback list search (answer text)', surfaces: [S('list-search', { route: '/assessment/feedback', placeholder: 'Search questions, dimensions or teams…', keyword: 'rolling' }), S('composer', { route: '/assessment/feedback', grammar: 'search rolling deploys' })] },
  { id: 'a-staged', role: 'lead-assessor', intent: 'Submissions not yet committed',
    phrasings: ['staged submissions', 'submissions not committed', 'show staged submissions'],
    expected: { summary: 'TEAM-003 form12 from Sam Okafor (staged)', text: [/sam.okafor|Checkout Experience/i] },
    best: 'submissions composer', surfaces: [S('composer', { route: '/assessment/submissions', grammar: 'show staged submissions' }), S('list-search', { route: '/assessment/submissions', placeholder: 'Search submissions', keyword: 'staged' })] },
  { id: 'a-submission-by', role: 'assessor', intent: 'A person\'s submission',
    phrasings: ["Jordan Lee's submission", 'submission from jordan lee', 'jordan-lee'],
    expected: { summary: 'TEAM-002 sub-20260810T091500Z-form5-jordan-lee-r3 (committed)', text: [/jordan.lee/i] },
    best: 'submissions list search', surfaces: [S('list-search', { route: '/assessment/submissions', placeholder: 'Search submissions', keyword: 'jordan' }), S('composer', { route: '/assessment/submissions', grammar: 'search jordan' })] },
  { id: 'a-dimension-evidence', role: 'assessor', intent: 'Evidence for a dimension on a team',
    phrasings: ['CI evidence for Northstar', 'continuous integration score Northstar', 'Northstar CI claim'],
    expected: { summary: 'TEAM-001 dimension 1 (CI): self-claimed 5, scored 2; story "Close the open CI claim…"', text: [/Close the open CI claim|Continuous Integration/i] },
    best: 'a tenant search across teams × dimensions × stories', surfaces: [S('palette', { route: AS_TEAMS }), S('composer', { route: AS_TEAMS, grammar: 'search Northstar' })] },
  { id: 'a-standard-doc', role: 'assessor', intent: 'Find a standards document',
    phrasings: ['N/A exception policy', 'what counts as evidence', 'CI/CD standards'],
    expected: { summary: 'Knowledge docs "N/A Exception Policy", "What Counts as Evidence", "CI/CD Standards"', text: [/Exception Policy|Counts as Evidence|CI\/CD Standards/i] },
    best: 'workspace document search', surfaces: [S('list-search', { route: '/assessment/workspace', placeholder: 'Search documents and files', keyword: 'evidence' }), S('composer', { route: AS_TEAMS, grammar: 'what counts as evidence' }), S('palette', { route: AS_TEAMS })] },
  { id: 'a-recording', role: 'lead-assessor', intent: 'Find a recorded huddle',
    phrasings: ['huddle about Northstar', 'recordings mentioning CI', 'Northstar call recording'],
    expected: { summary: 'Team huddle on assessment:team:TEAM-001 (Asha + Jonas, 22 min, 4h ago)', text: [/huddle|Northstar/i] },
    best: 'recording content search', surfaces: [S('palette', { route: AS_TEAMS }), S('api', { path: '/api/assessment/recordings/search?q={q}&teamId=TEAM-001' })] },
  { id: 'a-skill-team', role: 'assessor', intent: 'Ambiguous term that names a team (Kubernetes)',
    phrasings: ['Kubernetes', 'kubernetes team', 'the operator team'],
    expected: { summary: 'TEAM-002 Kubernetes Operator', text: [/Kubernetes Operator/] },
    best: 'palette record jump', surfaces: [S('palette', { route: AS_TEAMS }), S('list-search', { route: AS_TEAMS, placeholder: 'Search by team name or ID…', keyword: 'Kubernetes' })] },
]);

// ── social ───────────────────────────────────────────────────────────────────
const CH = '/social/channels';
export const SOCIAL = tenantOf('social')([
  { id: 's-find-channel', role: 'participant', intent: 'Find a channel',
    phrasings: ['incidents channel', '#incidents', 'incidents'],
    expected: { summary: '#incidents (owner Rachel Kowalski)', text: [/incidents/i] },
    best: 'palette record jump', surfaces: [S('palette', { route: CH }), S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'incidents' })] },
  { id: 's-find-person', role: 'participant', intent: 'Find a person',
    phrasings: ['Lena Brandt', 'find Lena', 'message Lena'],
    expected: { summary: 'u-lena Lena Brandt (moderator)', text: [/Lena Brandt/] },
    best: 'palette person jump + contacts', surfaces: [S('palette', { route: CH }), S('list-search', { route: '/social/contacts', placeholder: 'Find a person', keyword: 'Lena' }), S('composer', { route: '/social/contacts', grammar: 'search contacts for Lena' })] },
  { id: 's-presence', role: 'participant', intent: "Who's around right now",
    phrasings: ["who's online now", 'who is here', 'show away contacts'],
    expected: { summary: 'the presence tally of the loaded roster: how many are here now, away, offline', text: [/Here now: \d+/i], derived: 'live presence of the loaded contact roster (connected and active, connected and idle, offline); no fixture row holds it' },
    best: 'contacts composer ("show away")', surfaces: [S('composer', { route: '/social/contacts', grammar: 'show away' }), S('palette', { route: CH })] },
  { id: 's-message-community-call', role: 'participant', intent: 'Find a message by what it said',
    phrasings: ['when is the community call', 'community call time', 'community call Thursday'],
    expected: { summary: '#general g01 (Mira): "community call moves to Thursdays at 3pm"', text: [/Thursdays? at 3/i] },
    best: 'message search (tenant search over chat history)', surfaces: [S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'community call' }), S('palette', { route: CH })] },
  { id: 's-release-train', role: 'participant', intent: 'Find an announcement',
    phrasings: ['when does the release train leave', 'release train', 'sign-off deadline'],
    expected: { summary: '#general g10 (Sienna): release train leaves Friday, sign-offs by Thursday noon', text: [/Thursday noon|leaves Friday/i] },
    best: 'message search', surfaces: [S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'release train' }), S('palette', { route: CH })] },
  { id: 's-incident-cause', role: 'moderator', intent: 'Why did an incident happen',
    phrasings: ['why were transcripts delayed', 'transcript delay incident', 'root cause sev 3'],
    expected: { summary: '#incidents i08/i09: a queue sized for 30-minute calls', text: [/30-minute calls/i] },
    best: 'message search + summarize', surfaces: [S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'transcripts' }), S('palette', { route: CH })] },
  { id: 's-pinned', role: 'moderator', intent: "What's pinned in a channel",
    phrasings: ['pinned messages in incidents', "what's pinned", 'pins'],
    expected: { summary: '#incidents i01 (stale search health check) and 5 more pins', text: [/health check|pinned/i] },
    best: 'channel pins panel reachable from palette', surfaces: [S('palette', { route: CH }), S('api', { path: '/api/chat/pins?channel=incidents' })] },
  { id: 's-cutover-window', role: 'moderator', intent: 'Find a pinned plan',
    phrasings: ['what is the cutover plan', 'auth migration cutover plan', 'pinned cutover plan'],
    expected: { summary: '#auth-migration pin a01 (Vera): rehearse the cutover runbook on two internal tenants, then move customer tenants off the SAML shim', text: [/rehearse the cutover runbook|two internal tenants/i] },
    best: 'message/pin search', surfaces: [S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'cutover' }), S('palette', { route: CH })] },
  { id: 's-channel-members', role: 'community-admin', intent: 'Who is in a channel',
    phrasings: ['who is in #events', 'events channel members', 'members of events'],
    expected: { summary: 'Mira, Lena, Sana, Farah, Asha, Jonas', text: [/Farah|Jonas|Asha/] },
    best: 'channel header member list via palette', surfaces: [S('palette', { route: CH }), S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'events' })] },
  { id: 's-channel-owner', role: 'moderator', intent: 'Who owns a channel',
    phrasings: ['who owns #design-reviews', 'design-reviews owner', 'design reviews channel'],
    expected: { summary: 'Lena Brandt owns #design-reviews', text: [/design-reviews/i] },
    best: 'palette channel jump', surfaces: [S('palette', { route: CH }), S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'design' })] },
  { id: 's-team-members', role: 'moderator', intent: 'Who is on a team',
    phrasings: ['who is on the Community team', 'Community team members', 'Community team'],
    expected: { summary: 'Community: Mira (owner), Lena, Sana', text: [/Community/] },
    best: 'teams page reachable from palette', surfaces: [S('palette', { route: CH })] },
  { id: 's-events-channel', role: 'community-admin', intent: 'Find the channel for a topic (events)',
    phrasings: ['events channel', 'where do we post events', '#events'],
    expected: { summary: '#events (Mira owns it; the community call notes are pinned there)', text: [/events/i] },
    best: 'palette record jump', surfaces: [S('palette', { route: CH }), S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'events' })] },
  { id: 's-dm', role: 'community-admin', intent: 'Find a direct conversation',
    phrasings: ['my DM with Theo', 'conversation with Theo', 'Theo Chang'],
    expected: { summary: 'mira|theo DM (last: "Approved.")', text: [/Theo/] },
    best: 'palette DM jump + chat rail filter', surfaces: [S('palette', { route: CH }), S('list-search', { route: '/social/dms', placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'Theo' })] },
  { id: 's-missed-calls', role: 'participant', intent: 'Missed calls',
    phrasings: ['missed calls', 'who called me', 'call history'],
    expected: { summary: 'Mira → Sana missed, 2h ago', text: [/Mira|missed/i] },
    best: 'palette to /social/calls', surfaces: [S('palette', { route: CH })] },
  { id: 's-live-huddle', role: 'participant', intent: 'Is anyone in a huddle',
    phrasings: ['is anyone in a huddle', 'live calls now', 'join the huddle'],
    expected: { summary: 'Live huddle in #general (Mira, Lena)', text: [/general|huddle/i] },
    best: 'palette', surfaces: [S('palette', { route: CH })] },
  { id: 's-recording-decision', role: 'participant', intent: 'What was decided in a recorded call',
    phrasings: ['what was decided at the town hall', 'town hall recording', 'event calendar owner'],
    expected: { summary: 'mock-rec-town-hall-1: event calendar goes live Friday with Sana as owner', text: [/Town hall/i] },
    best: 'recording transcript search', surfaces: [S('palette', { route: CH })] },
  { id: 's-room', role: 'participant', intent: 'Find a room',
    phrasings: ['Design crit room', 'town hall room', 'rooms'],
    expected: { summary: 'Rooms "Design crit", "Town hall"', text: [/Design crit|Town hall/i] },
    best: 'palette record jump', surfaces: [S('palette', { route: CH })] },
  { id: 's-mod-guidelines', role: 'moderator', intent: 'Find the moderation guidelines',
    phrasings: ['moderation guidelines', 'moderators channel', 'escalation steps'],
    expected: { summary: '#moderators pin m01 (moderation guidelines)', text: [/moderat/i] },
    best: 'palette channel jump', surfaces: [S('palette', { route: CH }), S('list-search', { route: CH, placeholder: 'Find a chat', boxTestId: 'social-rail-search', railRows: true, keyword: 'moderators' })] },
]);

// ── pipelines ────────────────────────────────────────────────────────────────
const RUNS = '/pipelines/runs';
export const PIPELINES = tenantOf('pipelines')([
  { id: 'p-failed-runs', role: 'operator', intent: 'Which runs failed this week',
    phrasings: ['which runs failed this week', 'failed runs', 'runs that failed'],
    expected: { summary: 'JWKS token-verifier project run (2d), two assessment runs', text: [/token verifier|JWKS|confluence|self-assessment/i] },
    best: 'runs composer ("show failed runs")', surfaces: [S('composer', { route: RUNS, grammar: 'show failed runs' }), S('palette', { route: RUNS }), S('list-search', { route: RUNS, placeholder: 'Search loaded run titles', keyword: 'failed' })] },
  { id: 'p-running', role: 'operator', intent: "What's running now",
    phrasings: ["what's running", 'running runs', 'in-flight runs'],
    expected: { summary: 'p99 latency panel project run, score-dimensions, two marketplace runs', text: [/p99|score-dimensions|running/i] },
    best: 'runs composer', surfaces: [S('composer', { route: RUNS, grammar: 'show running runs' }), S('palette', { route: RUNS })] },
  { id: 'p-run-error', role: 'operator', intent: 'Why did a run fail',
    phrasings: ['why did the token verifier run fail', 'verify.test.ts failure', 'JWKS run error'],
    expected: { summary: '"npm test failed in auth/verify.test.ts (3 failing)"', text: [/verify\.test|token verifier|JWKS/i] },
    best: 'runs title search → run record', surfaces: [S('composer', { route: RUNS, grammar: 'search titles for token verifier' }), S('list-search', { route: RUNS, placeholder: 'Search loaded run titles', keyword: 'token verifier' }), S('palette', { route: RUNS })] },
  { id: 'p-pending-approvals', role: 'operator', intent: 'What is waiting for my approval',
    phrasings: ['what is waiting for my approval', 'pending approvals', 'approvals I need to decide'],
    expected: { summary: 'change:9f2c… "Suppress downstream pages during a cluster-wide outage" and consult con-mock-1', text: [/Suppress downstream pages|smallest-first|riskiest-first/i] },
    best: 'approvals page via palette + composer', surfaces: [S('palette', { route: RUNS }), S('composer', { route: '/pipelines/approvals', grammar: 'search approvals for suppress' }), S('list-search', { route: '/pipelines/approvals', placeholder: 'Search approvals', keyword: 'suppress' })] },
  { id: 'p-who-approved', role: 'operator', intent: 'Who approved a change',
    phrasings: ['who approved RED dashboards', 'who decided the alert dedup change', 'RED dashboards approval'],
    expected: { summary: '"RED dashboards" delivered; "Alert dedup" changes requested (decider not surfaced)', text: [/RED dashboards|Alert dedup/i] },
    best: 'approvals history with decider', surfaces: [S('list-search', { route: '/pipelines/approvals', placeholder: 'Search approvals', keyword: 'RED' }), S('palette', { route: RUNS })] },
  { id: 'p-find-definition', role: 'author', intent: 'Find a definition',
    phrasings: ['score-dimensions', 'find the score dimensions command', 'open score-dimensions'],
    expected: { summary: 'assessment:score-dimensions (owner orgiq-assessment-scorer)', text: [/score.dimensions/i] },
    best: 'palette record jump', surfaces: [S('palette', { route: RUNS }), S('composer', { route: '/pipelines/commands', grammar: 'search commands for score' }), S('list-search', { route: '/pipelines/definitions', placeholder: 'Search definitions', keyword: 'score' })] },
  { id: 'p-def-owner', role: 'author', intent: 'Who owns a definition',
    phrasings: ['who owns draw-diagram', 'owner of the draw-diagram command', 'draw-diagram'],
    expected: { summary: 'Ines Moreau owns assessment:draw-diagram (the definition row\'s owner column)', text: [/Ines Moreau|drafter/i] },
    best: 'definitions list row (owner column)', surfaces: [S('list-search', { route: '/pipelines/definitions', placeholder: 'Search definitions', keyword: 'draw-diagram' }), S('palette', { route: RUNS })] },
  { id: 'p-paused-bots', role: 'pipeline-admin', intent: 'Which bots are paused',
    phrasings: ['which bots are paused', 'disabled bots', 'show paused bots'],
    expected: { summary: 'All 12 bots (obs-nightly-maintenance … api-contract-watch) are disabled, awaiting repo provisioning', text: [/obs-nightly-maintenance|finops-daily-sweep|auth-dep-watch/i] },
    best: 'bots composer filter', surfaces: [S('composer', { route: '/pipelines/bots', grammar: 'show paused bots' }), S('palette', { route: RUNS })] },
  { id: 'p-bot-last-run', role: 'pipeline-admin', intent: 'When did a bot last run',
    phrasings: ['when did finops-daily-sweep last run', 'finops sweep last run', 'finops-daily-sweep'],
    expected: { summary: 'finops-daily-sweep last ran ~26 hours ago, 0 runs today', text: [/finops/i] },
    best: 'runs ledger filtered by bot', surfaces: [S('composer', { route: RUNS, grammar: 'search titles for finops' }), S('list-search', { route: '/pipelines/bots', placeholder: 'Search bots', keyword: 'finops' }), S('palette', { route: RUNS })] },
  { id: 'p-runbook', role: 'author', intent: 'Find a runbook',
    phrasings: ['security group runbook', 'custodian runbook', 'allow-list for security groups'],
    expected: { summary: 'runbook:promo-custodian-sg-drift "Custodian revokes open security-group ingress…"', text: [/Custodian|security-group/i] },
    best: 'runbooks search', surfaces: [S('list-search', { route: '/pipelines/runbooks', placeholder: 'Search runbooks', keyword: 'custodian' }), S('composer', { route: '/pipelines/runbooks', grammar: 'search runbooks for custodian' }), S('palette', { route: RUNS })] },
  { id: 'p-needs-dry-run', role: 'author', intent: 'Runbooks that still need a dry run',
    phrasings: ['runbooks needing a dry run', 'never dry-run', 'show needs dry-run runbooks'],
    expected: { summary: 'the runbooks with no completed dry run: "Backfill a month of events without duplicating rows" and "Resume a nightly ingest from its last checkpoint"', text: [/Backfill a month of events|Resume a nightly ingest/i] },
    best: 'runbooks composer filter', surfaces: [S('composer', { route: '/pipelines/runbooks', grammar: 'show needs dry-run runbooks' })] },
  { id: 'p-dead-letter', role: 'operator', intent: 'Dead-letter queue',
    phrasings: ['dead letter queue', 'files that failed to load', 'show dead-letter queues'],
    expected: { summary: 'ingest-landing-dlq "Files that failed three loads and need a person"', text: [/failed three loads|dead.letter/i] },
    best: 'queues composer filter', surfaces: [S('composer', { route: '/pipelines/queues', grammar: 'show dead-letter queues' }), S('list-search', { route: '/pipelines/queues', placeholder: 'Search queues', keyword: 'dead' }), S('palette', { route: RUNS })] },
  { id: 'p-run-failure-reason', role: 'operator', intent: 'Why did the token-verifier run fail',
    phrasings: ['why did the token verifier run fail', 'token verifier failure', 'JWKS rotation test failure'],
    expected: { summary: 'the token-verifier project run failed: 3 tests still expect the signing key from before the last JWKS rotation', text: [/JWKS|token verifier/i] },
    best: 'run record with its error, reachable from palette', surfaces: [S('palette', { route: RUNS }), S('composer', { route: RUNS, grammar: 'show failed runs' })] },
  { id: 'p-assessment-runs', role: 'operator', intent: 'Runs from another workspace',
    phrasings: ['assessment runs', 'show assessment runs', 'runs from the assessment workspace'],
    expected: { summary: 'assessment command runs (score-dimensions running; two failed)', text: [/score-dimensions|confluence|self-assessment/i] },
    best: 'runs composer (workspace filter)', surfaces: [S('composer', { route: RUNS, grammar: 'show assessment runs' }), S('palette', { route: RUNS })] },
  { id: 'p-transcript-artifacts', role: 'author', intent: 'Artifacts of a kind',
    phrasings: ['transcript artifacts', 'show transcript artifacts', 'transcripts'],
    expected: { summary: 'Artifacts with kind transcript', text: [/transcript/i] },
    best: 'artifacts composer filter', surfaces: [S('composer', { route: '/pipelines/artifacts', grammar: 'show transcript artifacts' }), S('palette', { route: RUNS })] },
  { id: 'p-run-cost', role: 'pipeline-admin', intent: 'Most expensive runs',
    phrasings: ['most expensive runs', 'run cost this week', 'what did runs cost today'],
    expected: { summary: 'JWKS run $0.81; obs-nightly-maintenance $0.16 + $0.10 today', text: [/\$?0\.81\b|\$0\.16/] },
    best: 'runs ledger sort by cost', surfaces: [S('composer', { route: RUNS, grammar: 'show expensive runs' }), S('palette', { route: RUNS })] },
]);

// ── access ───────────────────────────────────────────────────────────────────
const REQ = '/access/requests';
export const ACCESS = tenantOf('access')([
  { id: 'x-my-pending', role: 'requester', cloneBlind: 'access requests are "mine" by session.sub (routes/access.ts isParty), so a clone of u-rhea owns none', intent: 'My pending access requests',
    phrasings: ['my pending access requests', 'my open requests', 'what am I waiting on'],
    expected: { summary: 'req-0001 (SME in Work, waiting on Omar) and req-0002 (Member of Auth Migration, steward step)', text: [/req-0001|req-0002/] },
    best: 'requests composer ("show open requests")', surfaces: [S('composer', { route: REQ, grammar: 'show open requests' }), S('palette', { route: REQ }), S('list-search', { route: REQ, placeholder: 'Search requests', keyword: 'pending' })] },
  { id: 'x-request-status', role: 'requester', cloneBlind: 'access requests are "mine" by session.sub (routes/access.ts isParty), so a clone of u-rhea owns none', intent: 'Status of a specific request',
    phrasings: ['status of req-0002', 'req-0002', 'where is my auth migration request'],
    expected: { summary: 'req-0002 pending — manager approved, steward step current', text: [/req-0002/] },
    best: 'palette record jump (req-NNNN)', surfaces: [S('palette', { route: REQ }), S('composer', { route: REQ, grammar: 'open req-0002' }), S('list-search', { route: REQ, placeholder: 'Search requests', keyword: 'req-0002' })] },
  { id: 'x-why-rejected', role: 'requester', cloneBlind: 'access requests are "mine" by session.sub (routes/access.ts isParty), so a clone of u-rhea owns none', intent: 'Why was my request rejected',
    phrasings: ['why was my org leader request rejected', 'rejected requests', 'show closed requests'],
    expected: { summary: 'req-0005 rejected by Omar: "The review does not need leaderboard access…"', text: [/req-0005|leaderboard access/i] },
    best: 'requests composer filter + record', surfaces: [S('composer', { route: REQ, grammar: 'show closed requests' }), S('list-search', { route: REQ, placeholder: 'Search requests', keyword: 'Org leader' }), S('palette', { route: REQ })] },
  { id: 'x-withdrawn', role: 'requester', cloneBlind: 'access requests are "mine" by session.sub (routes/access.ts isParty), so a clone of u-rhea owns none', intent: 'Withdrawn requests',
    phrasings: ['withdrawn requests', 'requests I withdrew', 'my moderator request'],
    expected: { summary: 'req-0006 Moderator in Social, withdrawn 9 days ago', text: [/req-0006/] },
    best: 'requests composer filter', surfaces: [S('composer', { route: REQ, grammar: 'show closed requests' }), S('list-search', { route: REQ, placeholder: 'Search requests', keyword: 'Moderator' })] },
  { id: 'x-find-entitlement', role: 'requester', intent: 'How do I get access to X',
    phrasings: ['budget visibility', 'how do I get budget access', 'request budget access'],
    expected: { summary: 'capability:orgiq:budgets-read "Budget visibility in Work"', text: [/Budget visibility/i] },
    best: 'catalog search', surfaces: [S('list-search', { route: '/access/catalog', placeholder: 'Search the catalog', keyword: 'budget' }), S('composer', { route: '/access/catalog', grammar: 'search budget' }), S('palette', { route: REQ }), S('api', { path: '/api/access/catalog?q=budget' })] },
  { id: 'x-join-initiative', role: 'requester', intent: 'Access to an initiative',
    phrasings: ['access to auth migration', 'join Auth Migration', 'Auth Migration membership'],
    expected: { summary: 'initiative:p-auth-migration in the catalog; req-0002 already pending', text: [/Auth Migration/] },
    best: 'catalog search', surfaces: [S('list-search', { route: '/access/catalog', placeholder: 'Search the catalog', keyword: 'Auth Migration' }), S('composer', { route: '/access/catalog', grammar: 'search Auth Migration' }), S('palette', { route: REQ })] },
  { id: 'x-sensitive', role: 'requester', intent: 'Which roles are sensitive',
    phrasings: ['sensitive roles', 'which roles need extra approval', 'show sensitive'],
    expected: { summary: 'role:orgiq:org-leader and role:assessment:lead-assessor are sensitive', text: [/Org leader|Lead assessor/i] },
    best: 'catalog composer filter', surfaces: [S('composer', { route: '/access/catalog', grammar: 'show sensitive' }), S('list-search', { route: '/access/catalog', placeholder: 'Search the catalog', keyword: 'sensitive' })] },
  { id: 'x-waiting-on-me', role: 'approver', intent: 'What is waiting on me',
    phrasings: ["what's waiting on me", 'approvals pending', 'requests I need to approve'],
    expected: { summary: 'req-0001 (Rhea → SME in Work), manager step — on the Approvals page ("Requests waiting on your decision")', text: [/req-0001|SME in Work|Requests waiting on your decision/] },
    best: 'approvals page via palette', surfaces: [S('palette', { route: REQ }), S('composer', { route: '/access/approvals', grammar: 'search approvals for req-0001' }), S('list-search', { route: '/access/approvals', placeholder: 'Search approvals', keyword: 'Rhea' })] },
  { id: 'x-reports-requests', role: 'approver', intent: "My reports' requests",
    phrasings: ["Rhea's requests", 'requests from my reports', 'what has Rhea asked for'],
    expected: { summary: 'Rhea Castellanos (a report of the approver): req-0001, req-0002, req-0005, req-0006', text: [/req-000[1256]/] },
    best: 'requests search by requester', surfaces: [S('list-search', { route: REQ, placeholder: 'Search requests', keyword: 'Rhea' }), S('composer', { route: REQ, grammar: 'search Rhea' }), S('api', { path: '/api/access/requests?scope=reports&q=Rhea' })] },
  { id: 'x-delegation', role: 'approver', intent: 'Who covers my approvals',
    phrasings: ["who covers my approvals while I'm away", 'delegations', 'my delegate'],
    expected: { summary: 'dlg-0001 Omar → Priya (expired)', text: [/Priya/] },
    best: 'palette to delegations', surfaces: [S('palette', { route: REQ })] },
  { id: 'x-who-approved', role: 'access-admin', intent: 'Who approved a request',
    phrasings: ['who approved req-0003', "who approved Omar's operator access", 'req-0003 approval'],
    expected: { summary: 'Priya approved both steps of req-0003 (4 and 3 days ago)', text: [/req-0003/] },
    best: 'audit search', surfaces: [S('list-search', { route: '/access/audit', placeholder: 'Search events', keyword: 'req-0003' }), S('composer', { route: '/access/audit', grammar: 'search req-0003' }), S('palette', { route: REQ })] },
  { id: 'x-person-access', role: 'access-admin', intent: 'What access does a person have',
    phrasings: ['what access does Nora have', "Nora's grants", 'Nora DaSilva access'],
    expected: { summary: 'req-0004: Nora holds SME in Work (active, standing grant)', text: [/req-0004|Nora/] },
    best: 'person access view (no entity today)', surfaces: [S('list-search', { route: REQ, placeholder: 'Search requests', keyword: 'Nora' }), S('composer', { route: REQ, grammar: 'search Nora' }), S('palette', { route: REQ })] },
  { id: 'x-sod', role: 'access-admin', intent: 'Separation-of-duties conflicts',
    phrasings: ['separation of duties conflicts', 'blocking policies', 'show blocking policies'],
    expected: { summary: 'sod-001 "Spend and allocate", sod-002 "Write and approve a pipeline" (block)', text: [/Spend and allocate|Write and approve a pipeline/i] },
    best: 'policies composer filter', surfaces: [S('composer', { route: '/access/policies', grammar: 'show blocking policies' }), S('palette', { route: REQ })] },
  { id: 'x-review-undecided', role: 'access-admin', intent: 'Who still needs a review decision',
    phrasings: ['undecided review items', 'who still needs a decision in the SME certification', 'open reviews'],
    expected: { summary: 'rev-0001 Q4 SME certification: Layla and Caleb undecided', text: [/Q4 SME certification|Layla|Caleb/i] },
    best: 'reviews composer + review record', surfaces: [S('composer', { route: '/access/reviews', grammar: 'show open reviews' }), S('palette', { route: REQ })] },
  { id: 'x-temporary', role: 'access-admin', intent: 'Time-bound grants',
    phrasings: ['temporary access expiring', 'time-bound grants', 'access that lapses'],
    expected: { summary: 'req-0003 Operator in Pipelines for 7 days', text: [/req-0003|7 days|Operator/i] },
    best: 'requests filter by duration', surfaces: [S('composer', { route: REQ, grammar: 'show active requests' }), S('palette', { route: REQ })] },
  { id: 'x-overrides', role: 'access-admin', intent: 'Override events in the audit log',
    phrasings: ['overrides in the audit log', 'show override events', 'policy overrides'],
    expected: { summary: 'Audit events of kind override (evt-00NN)', text: [/override/i] },
    best: 'audit composer filter', surfaces: [S('composer', { route: '/access/audit', grammar: 'show override' }), S('palette', { route: REQ })] },
]);

export const CATALOG: Intent[] = [...ORGIQ, ...ASSESSMENT, ...SOCIAL, ...PIPELINES, ...ACCESS];

/** The catalog as the results JSON records it (regexes as source/flags), so the report and the judge need no TS. */
export function serializeIntents(intents: Intent[] = CATALOG) {
  return intents.map((i) => ({
    id: i.id, tenant: i.tenant, role: i.role, persona: i.persona, intent: i.intent, phrasings: i.phrasings, best: i.best, bestSurface: i.bestSurface, map: !!i.map,
    expected: { summary: i.expected.summary, keys: i.expected.keys ?? [], text: i.expected.text.map((r) => ({ source: r.source, flags: r.flags })), wrong: (i.expected.wrong ?? []).map((r) => ({ source: r.source, flags: r.flags })), derived: i.expected.derived ?? null },
    surfaces: i.surfaces, cloneBlind: i.cloneBlind ?? null,
  }));
}
