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
 */
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
        executionCount: 7,
        lastCode: 'import json\nentities = extract_ner(doc_text)\nprint(json.dumps(entities, indent=2))',
        lastOutput: '{"people": ["Alice Smith", "Bob Jones"], "skills": ["Kubernetes", "Python"]}',
        memoryUsageMb: 128,
      },
      {
        sessionId: 'cs-e5f6g7h8',
        agentName: 'scoring',
        status: 'IDLE',
        startedAt: clock.hoursAgo(15 / 60),
        lastActivityAt: clock.hoursAgo(7 / 60),
        executionCount: 3,
        lastCode: 'pagerank = compute_pagerank(graph, damping=0.85, iterations=20)\nprint(sorted(pagerank.items(), key=lambda x: -x[1])[:10])',
        lastOutput: "[('alice_smith', 0.89), ('bob_jones', 0.73), ('carol_wu', 0.61)]",
        memoryUsageMb: 64,
      },
    ],
    empty: () => [],
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
 */
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
        currentUrl: 'https://linkedin.com/in/alice-smith',
        pageTitle: 'Alice Smith | LinkedIn',
        requestCount: 12,
        profileId: 'bp-default',
      },
      {
        sessionId: 'bs-q5r6s7t8',
        agentName: 'advisor',
        status: 'IDLE',
        startedAt: clock.hoursAgo(10 / 60),
        lastActivityAt: clock.hoursAgo(5 / 60),
        currentUrl: 'about:blank',
        pageTitle: '',
        requestCount: 4,
        profileId: 'bp-default',
      },
    ],
    empty: () => [],
  },
});

/** Live view — see mock/live.ts. */
export const mockBrowserSessions: BrowserSession[] = liveRows(browserSessions);
