// AgentCore capability state: the guardrail, and the live Code Interpreter /
// Browser sessions the Capabilities page lists.
//
// Every timestamp in here was `new Date(Date.now() - N).toISOString()` at
// module scope — contract.ts bug #3, six times over. A browser session that
// claims it was last active five seconds ago is claiming something about NOW;
// baked at import, it claimed something about whenever the process happened to
// start, so a `dev:mock` server left up over lunch showed an "ACTIVE" session
// whose last activity was two hours in the past and a code session that had
// apparently been idle since breakfast. They are `clock` calls inside the rows
// factories now, so a session that says "5s ago" means five seconds before the
// request that rendered it.

import { clock, defineFixture } from './core/index.js';
import { liveRows } from './live.js';

// ── Guardrail ──────────────────────────────────────────────────────────────

export interface MockGuardrail {
  id: string;
  name: string;
  status: string;
  version: string;
  updatedAt: string;
  piiFilters: Array<{ type: string; action: string; enabled: boolean }>;
  contentPolicy: {
    hateEnabled: boolean;
    violenceEnabled: boolean;
    sexualEnabled: boolean;
    insultsEnabled: boolean;
    misconductEnabled: boolean;
    promptAttackEnabled: boolean;
  };
  deniedTopics: Array<{ name: string; definition: string; enabled: boolean }>;
  groundingThreshold: number;
  relevanceThreshold: number;
}

/**
 * The guardrail, as a one-row fixture.
 *
 * One object rather than a list, but it lives behind the registry for the same
 * reason everything else does: the other worlds have to be askable.
 *
 * `empty` — a guardrail that exists and blocks nothing: no PII filters, no
 *           denied topics, every content policy off. That is what "nothing
 *           configured" looks like on this surface, and it is deliberately NOT
 *           a zero-row list — `getGuardrail()` is non-nullable on the provider
 *           interface, so an absent row would force either a 500 (an error
 *           state, which is a different audit) or an invented status string
 *           the real API never sends.
 * `error` — the guardrail is stuck in FAILED, which is what a rejected
 *           UpdateGuardrail leaves behind and what the page's error banner is
 *           written for.
 */
export const guardrail = defineFixture<MockGuardrail>({
  key: 'guardrail',
  scenarios: {
    default: () => [seedGuardrail()],
    empty: () => [
      {
        ...seedGuardrail(),
        piiFilters: [],
        deniedTopics: [],
        contentPolicy: {
          hateEnabled: false,
          violenceEnabled: false,
          sexualEnabled: false,
          insultsEnabled: false,
          misconductEnabled: false,
          promptAttackEnabled: false,
        },
      },
    ],
    error: () => [{ ...seedGuardrail(), status: 'FAILED', updatedAt: clock.hoursAgo(1, { keepWithinToday: true }) }],
  },
});

function seedGuardrail(): MockGuardrail {
  return {
    id: 'gr-mock-001',
    name: 'orgiq-guardrail',
    status: 'READY',
    version: '1',
    updatedAt: clock.daysAgo(1),
    piiFilters: [
      { type: 'EMAIL', action: 'ANONYMIZE', enabled: true },
      { type: 'PHONE', action: 'ANONYMIZE', enabled: true },
      { type: 'SSN', action: 'BLOCK', enabled: true },
      { type: 'NAME', action: 'ANONYMIZE', enabled: false },
    ],
    contentPolicy: {
      hateEnabled: true,
      violenceEnabled: true,
      sexualEnabled: true,
      insultsEnabled: true,
      misconductEnabled: true,
      promptAttackEnabled: true,
    },
    deniedTopics: [
      { name: 'Competitor Analysis', definition: 'Requests about specific competitor products', enabled: true },
      { name: 'Salary Disclosure', definition: 'Requests to reveal individual salary information', enabled: true },
      { name: 'Legal Advice', definition: 'Requests for legal counsel or binding legal opinions', enabled: false },
    ],
    groundingThreshold: 0.75,
    relevanceThreshold: 0.70,
  };
}

/**
 * The live guardrail row, or `null` when none is attached.
 *
 * `providers/guardrails.ts` mutates what this returns in place so a mock
 * session's edits stick — which works because `rows()` hands back the
 * fixture's own array, and `reset()` is what takes an audit's edits back.
 */
export function mockGuardrailRow(): MockGuardrail | null {
  return guardrail.rows()[0] ?? null;
}

// ── Code Interpreter sessions ──────────────────────────────────────────────

export interface CodeSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'TERMINATED';
  startedAt: string;
  lastActivityAt: string;
  executionCount: number;
  lastCode: string;
  lastOutput: string;
  memoryUsageMb: number;
}

/**
 * Code Interpreter sessions.
 *
 * `empty` — no sandbox is running. This is the ordinary state between demos,
 *           and the one the "start a session" affordance is written for; the
 *           page previously could not be seen in it without terminating both
 *           seeded sessions and telling the next auditor in a log.
 * `error` — the AgentCore data plane cannot be listed. Throwing is the point:
 *           it is how an auditor reaches `listCodeSessionsResult`'s degraded
 *           branch over HTTP (`POST /api/__mock/scenario
 *           {"scenario":"error","fixture":"code-sessions"}`) rather than by
 *           unplugging a network, and it is what proves the degraded answer
 *           and the `empty` answer are two different responses. The message is
 *           the one a STALE `CODE_INTERPRETER_ID` really produces — CLAUDE.md
 *           records that every rebuild of OrgIQ-AgentCoreCapabilities mints
 *           fresh ids and leaves .env.aws pointing at the dead ones — because
 *           an invented failure would teach the reader the wrong symptom.
 */
// What each interpreter session has run, oldest first. `executionCount` is the
// length of its list and `lastCode` is its last entry, so the counter and the
// code it reports cannot disagree (middleware/src/mock/core/contract.ts rule 1).
const GRAPH_BUILDER_CODE = [
  'import json, re\nraw = open("auth-runbook.md").read()',
  'sections = re.split(r"^## ", raw, flags=re.M)\nprint(len(sections))',
  'people = extract_people(sections)\nprint(people)',
  'decisions = extract_decisions(sections)\nprint(decisions)',
  'edges = link(people, decisions)\nprint(len(edges))',
  'assert all(e.source and e.target for e in edges)',
  'import json\nentities = extract_ner(doc_text)\nprint(json.dumps(entities, indent=2))',
];
const SCORING_CODE = [
  'graph = load_subgraph("p-auth-migration")\nprint(graph.number_of_nodes())',
  'centrality = betweenness(graph)\nprint(max(centrality, key=centrality.get))',
  'pagerank = compute_pagerank(graph, damping=0.85, iterations=20)\nprint(sorted(pagerank.items(), key=lambda x: -x[1])[:10])',
];

export const codeSessions = defineFixture<CodeSession>({
  key: 'code-sessions',
  scenarios: {
    default: () => [
      {
        sessionId: 'cs-a1b2c3d4',
        agentName: 'graph-builder',
        status: 'ACTIVE',
        startedAt: clock.hoursAgo(5 / 60),
        lastActivityAt: clock.hoursAgo(15 / 3600),
        executionCount: GRAPH_BUILDER_CODE.length,
        lastCode: GRAPH_BUILDER_CODE[GRAPH_BUILDER_CODE.length - 1]!,
        lastOutput: '{"people": ["Vera Green", "Simone Chang", "Nora DaSilva"], "skills": ["OIDC", "JWKS", "Session management"]}',
        memoryUsageMb: 128,
      },
      {
        sessionId: 'cs-e5f6g7h8',
        agentName: 'scoring',
        status: 'IDLE',
        startedAt: clock.hoursAgo(15 / 60),
        lastActivityAt: clock.hoursAgo(7 / 60),
        executionCount: SCORING_CODE.length,
        lastCode: SCORING_CODE[SCORING_CODE.length - 1]!,
        lastOutput: "[('vera_green', 0.89), ('simone_chang', 0.73), ('nora_dasilva', 0.61)]",
        memoryUsageMb: 64,
      },
    ],
    empty: () => [],
    error: () => {
      throw new Error('ResourceNotFoundException: code interpreter ci-mock-stale not found');
    },
  },
});

/** Live view — see mock/live.ts. */
export const mockCodeSessions: CodeSession[] = liveRows(codeSessions);

// ── Browser sessions ───────────────────────────────────────────────────────

export interface BrowserSession {
  sessionId: string;
  agentName: string;
  status: 'ACTIVE' | 'IDLE' | 'CLOSED';
  startedAt: string;
  lastActivityAt: string;
  currentUrl: string;
  pageTitle: string;
  requestCount: number;
  profileId: string;
}

/**
 * Browser sessions.
 *
 * `empty` — no browser is open. Worth being able to ask for on its own: a
 *           dead `BROWSER_ID` in a deployed environment fails SOFT (the
 *           site-survey fallback cannot tell "no browser" from "this page
 *           needed no JavaScript"), so the empty rendering is the one an
 *           operator will be looking at when something is actually wrong.
 * `error` — and this is the other half of that same sentence: the listing
 *           itself fails. Until `listBrowserSessionsResult` existed the two
 *           were the same `{ sessions: [] }`, which is precisely why the soft
 *           failure was undiagnosable. The message is the real one a stale
 *           BROWSER_PROFILE_ID produces.
 */
// Pages each browser session has requested, oldest first; `requestCount` is the
// length of its list and `currentUrl` its last entry.
const SEARCH_BROWSER_PAGES = [
  'https://github.com/orgs/connorhoehn/repositories', 'https://github.com/connorhoehn/orgiq-auth-service',
  'https://github.com/connorhoehn/orgiq-auth-service/pulls', 'https://github.com/connorhoehn/orgiq-auth-service/pull/49',
  'https://github.com/connorhoehn/orgiq-auth-service/pull/49/files', 'https://github.com/connorhoehn/orgiq-auth-service/issues',
  'https://github.com/connorhoehn/orgiq-observability', 'https://github.com/connorhoehn/orgiq-observability/pulls',
  'https://github.com/connorhoehn/orgiq-llm-platform', 'https://github.com/connorhoehn/orgiq-llm-platform/pulls',
  'https://github.com/connorhoehn/orgiq-inference-platform', 'https://github.com/connorhoehn/orgiq-inference-platform/pulls',
];
const ADVISOR_BROWSER_PAGES = [
  'https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-tokens-verifying-a-jwt.html',
  'https://openid.net/specs/openid-connect-core-1_0.html', 'https://datatracker.ietf.org/doc/html/rfc7636', 'about:blank',
];

export const browserSessions = defineFixture<BrowserSession>({
  key: 'browser-sessions',
  scenarios: {
    default: () => [
      {
        sessionId: 'bs-m1n2o3p4',
        agentName: 'search',
        status: 'ACTIVE',
        startedAt: clock.hoursAgo(2 / 60),
        lastActivityAt: clock.hoursAgo(5 / 3600),
        currentUrl: SEARCH_BROWSER_PAGES[SEARCH_BROWSER_PAGES.length - 1]!,
        pageTitle: 'Pull requests · connorhoehn/orgiq-inference-platform',
        requestCount: SEARCH_BROWSER_PAGES.length,
        profileId: 'bp-default',
      },
      {
        sessionId: 'bs-q5r6s7t8',
        agentName: 'advisor',
        status: 'IDLE',
        startedAt: clock.hoursAgo(10 / 60),
        lastActivityAt: clock.hoursAgo(5 / 60),
        currentUrl: ADVISOR_BROWSER_PAGES[ADVISOR_BROWSER_PAGES.length - 1]!,
        pageTitle: '',
        requestCount: ADVISOR_BROWSER_PAGES.length,
        profileId: 'bp-default',
      },
    ],
    empty: () => [],
    error: () => {
      throw new Error('ValidationException: Browser profile not found');
    },
  },
});

/** Live view — see mock/live.ts. */
export const mockBrowserSessions: BrowserSession[] = liveRows(browserSessions);
