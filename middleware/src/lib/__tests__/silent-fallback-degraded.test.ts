// Three silent fallbacks in src/lib, and what they now say instead.
//
// None of these sit in a route, so nothing in
// routes/__tests__/swallowed-failure-scan.test.ts could see them — that file
// says so itself. Each turned "we could not read X" into a value that means
// something else entirely, and each of those values then fed a decision:
//
//   * site-survey's robots.txt read → `[]` → "this site restricts nothing",
//     so a timed-out or 503 robots.txt licensed an unrestricted crawl of a
//     third-party site and left no trace that it had happened.
//   * harness-runner's `expected_tags` parse → `[]` → "this case expects no
//     tags", so a case written to REQUIRE that the answer mention Aurora and
//     pgvector was quietly relaxed to require nothing and reported as PASSED.
//     An evaluation harness scoring green off an expectation it could not read
//     is the worst failure this tree has, because it is the thing that is
//     supposed to notice.
//   * pr-watch-poller's tick → nothing at all. No counter, no timestamp, one
//     `console.warn` per failed tick forever.

jest.mock('../../providers/aurora.js', () => ({ exec: jest.fn() }));
jest.mock('../../config.js', () => ({
  config: {
    region: 'us-east-1',
    mock: { aurora: false },
    agentcore: { browserId: '', browserProfileId: '' },
  },
}));
jest.mock('../../routes/invocations.js', () => ({ getRuntimeArn: jest.fn() }));
jest.mock('../judge-config.js', () => ({
  getJudgeConfig: jest.fn(async () => ({ dimensions: [] })),
  weightedComposite: jest.fn(() => 0),
}));
jest.mock('../../providers/index.js', () => ({ agentcore: {} }));
jest.mock('../vision-extractor.js', () => ({ extractFromScreenshot: jest.fn() }));
jest.mock('../github-connector.js', () => ({ listPulls: jest.fn(), getPullStatus: jest.fn() }));
jest.mock('../../providers/connected-sources.js', () => ({ borrowApiKey: jest.fn() }));
jest.mock('../../providers/bots.js', () => ({ createBotRun: jest.fn() }));
jest.mock('../bot-runner.js', () => ({ checkConcurrency: jest.fn(), botMaxConcurrent: () => 2 }));

import { disallowedPrefixes } from '../site-survey.js';
import { loadCasesForRun, runCase, type TestCase } from '../harness-runner.js';
import { prWatchHealth, resetPrWatchHealth, runPollTick } from '../pr-watch-poller.js';
import { exec } from '../../providers/aurora.js';
import { getRuntimeArn } from '../../routes/invocations.js';

const execMock = exec as unknown as jest.Mock;
const arnMock = getRuntimeArn as unknown as jest.Mock;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

// ── site-survey: robots.txt ──────────────────────────────────────────────────

describe('disallowedPrefixes — "no rules" versus "we do not know the rules"', () => {
  const respond = (init: { status: number; body?: string }): void => {
    globalThis.fetch = (async () => new Response(init.body ?? '', {
      status: init.status,
      headers: { 'content-type': 'text/plain' },
    })) as typeof globalThis.fetch;
  };

  it('reads real Disallow prefixes from the User-agent: * group', async () => {
    respond({ status: 200, body: 'User-agent: *\nDisallow: /admin\nDisallow: /private\n' });
    expect(await disallowedPrefixes('https://example.com')).toEqual({ items: ['/admin', '/private'] });
  });

  it('treats a 404 as the standard does — no restrictions, NOT a failure', async () => {
    // Most sites have no robots.txt. Marking that degraded would put a warning
    // on the ordinary case and train everyone to ignore the marker.
    respond({ status: 404 });
    expect(await disallowedPrefixes('https://example.com')).toEqual({ items: [] });
  });

  it('a 503 is degraded — the site would not tell us its rules', async () => {
    respond({ status: 503 });
    const r = await disallowedPrefixes('https://example.com');
    expect(r.items).toEqual([]);
    expect(r.degraded).toBe(true);
    expect(r.error).toContain('robots.txt');
  });

  it('a thrown fetch is degraded, and the crawl still gets its (empty) rules', async () => {
    globalThis.fetch = (async () => { throw new Error('TimeoutError'); }) as typeof globalThis.fetch;
    const r = await disallowedPrefixes('https://example.com');
    expect(r.items).toEqual([]);
    expect(r.degraded).toBe(true);
  });

  it('a site that really restricts nothing is NOT degraded', async () => {
    respond({ status: 200, body: 'User-agent: *\nAllow: /\n' });
    expect(await disallowedPrefixes('https://example.com')).toEqual({ items: [] });
  });
});

// ── harness-runner: expected_tags ────────────────────────────────────────────

describe('loadCasesForRun — an expectation that could not be read', () => {
  const row = (expected: string): Record<string, unknown> => ({
    test_id: 't-1', agent_id: 'orgiq-search', prompt: 'p',
    reference_output: null, expected_tags: expected, rubric_override: null, pass_threshold: 0.7,
  });

  it('an empty list is an ordinary case that expects no tags', async () => {
    execMock.mockResolvedValue([row('[]')]);
    const [c] = await loadCasesForRun();
    expect(c!.expectedTags).toEqual([]);
    expect(c!.expectationProblem).toBeNull();
  });

  it('malformed JSON says so instead of silently expecting nothing', async () => {
    execMock.mockResolvedValue([row('{not json')]);
    const [c] = await loadCasesForRun();
    expect(c!.expectedTags).toEqual([]);
    expect(c!.expectationProblem).toBeTruthy();
  });

  it('valid JSON of the wrong shape is caught too', async () => {
    execMock.mockResolvedValue([row('"aurora"')]);
    const [c] = await loadCasesForRun();
    expect(c!.expectationProblem).toMatch(/not a list/);
  });
});

describe('runCase — a case whose expectation is unreadable cannot pass', () => {
  const testCase = (over: Partial<TestCase> = {}): TestCase => ({
    testId: 't-1', agentId: 'orgiq-search', prompt: 'Who knows Kubernetes?',
    referenceOutput: null, expectedTags: [], rubricOverride: null, passThreshold: 0.7,
    ...over,
  });

  beforeEach(() => arnMock.mockResolvedValue(null));

  it('passes an ordinary no-tag case', async () => {
    const o = await runCase(testCase(), 'amazon.nova-pro-v1:0');
    // No runtime ARN → the invocation fails, which is its own recorded reason.
    // What matters here is that no expectation reason was added.
    expect(o.failReasons.some((r) => r.startsWith('expectation unreadable'))).toBe(false);
  });

  it('records the unreadable expectation as a reason, so it is never a green case', async () => {
    const o = await runCase(testCase({ expectationProblem: 'expected_tags is not valid JSON' }), 'm');
    expect(o.passed).toBe(false);
    expect(o.failReasons.join(' ')).toMatch(/expectation unreadable/);
  });
});

// ── pr-watch-poller: the tick nobody could see ───────────────────────────────

describe('the poller records what it did — a poller has no response to mark', () => {
  beforeEach(() => {
    resetPrWatchHealth();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('starts out saying it has never ticked, rather than saying it is fine', async () => {
    expect(prWatchHealth()).toMatchObject({ running: false, lastTickOk: null, consecutiveFailures: 0 });
  });

  it('records a completed tick', async () => {
    execMock.mockResolvedValue([]);
    await runPollTick();
    const h = prWatchHealth();
    expect(h.lastTickOk).toBe(true);
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastTickAt).not.toBeNull();
  });

  it('records a failed tick, with the reason and a streak', async () => {
    execMock.mockRejectedValue(new Error('Aurora is unreachable\n  at exec'));
    await runPollTick();
    await runPollTick();
    const h = prWatchHealth();
    expect(h.lastTickOk).toBe(false);
    expect(h.consecutiveFailures).toBe(2);
    expect(h.lastError).toBe('Aurora is unreachable');
  });

  it('logs the FIRST failure, then goes quiet until the streak is worth saying again', async () => {
    execMock.mockRejectedValue(new Error('nope'));
    const warn = console.warn as jest.Mock;
    for (let i = 0; i < 8; i++) await runPollTick();
    // Ticks 2..7 are silent; tick 1 and tick 8 (the streak threshold) speak.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[1])).toMatch(/8 consecutive tick/);
  });

  it('says when it RECOVERED — the half nobody ever logs', async () => {
    execMock.mockRejectedValue(new Error('nope'));
    await runPollTick();
    execMock.mockReset();
    execMock.mockResolvedValue([]);
    await runPollTick();
    expect(String((console.log as jest.Mock).mock.calls)).toMatch(/recovered after 1 failed tick/);
    expect(prWatchHealth().consecutiveFailures).toBe(0);
    // The error is kept beside a zeroed streak, so a reader can see what it was.
    expect(prWatchHealth().lastError).toBe('nope');
  });

  it('keeps a completed tick with per-item errors distinct from a failed tick', async () => {
    // A repo that could not be listed is counted and skipped; the tick still
    // completed. Collapsing the two would make one unreachable repository look
    // like a dead poller.
    execMock.mockResolvedValue([]);
    await runPollTick();
    expect(prWatchHealth()).toMatchObject({ lastTickOk: true, lastTickItemErrors: 0 });
  });
});
