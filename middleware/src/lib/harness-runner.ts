// The harness engine.
//
// The harness had cases, runs, results, comparison, promotion and a coverage
// report — everything except the part that runs a test. `POST /runs` inserted
// a row at status 'pending' and nothing ever moved it: no caller anywhere in
// the repo posted results, so every run sat at 0 completed forever and the
// evaluation surfaces reported on data that could never arrive.
//
// This is the missing middle. For each case it invokes the real agent runtime,
// judges the answer against the operator's rubric, applies the deterministic
// checks the case declares, and records a result. Nothing here is simulated.
//
// Two properties matter for an evaluation tool to be worth trusting:
//
//   1. A failure to invoke is a RESULT, not a crash. An agent that errors or
//      times out records a failed case with the reason, because "the agent
//      fell over on 3 of 40 prompts" is the single most useful thing an
//      evaluation can tell you, and losing it to an exception would be the
//      worst possible outcome.
//   2. The judge is advisory, the deterministic checks are not. Expected tags
//      and reference similarity are computed in code; only the qualitative
//      score comes from a model. A case can fail on a missing required tag
//      even when the judge liked the prose.

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { getJudgeConfig, weightedComposite } from './judge-config.js';
import { firstLine } from './upstream.js';
import { getRuntimeArn } from '../routes/invocations.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

/** Cases run concurrently. Small: these are real agent invocations. */
const CASE_CONCURRENCY = Number(process.env['HARNESS_CONCURRENCY'] ?? 3);
/** Hard ceiling on a single run so one click cannot invoke an agent 500 times. */
const MAX_CASES_PER_RUN = Number(process.env['HARNESS_MAX_CASES'] ?? 100);
const SNIPPET_CHARS = 1200;

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function n(name: string, value: number): SqlParameter { return { name, value: { doubleValue: value } }; }
function i(name: string, value: number): SqlParameter { return { name, value: { longValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }

let _agentcore: BedrockAgentCoreClient | null = null;
let _bedrock: BedrockRuntimeClient | null = null;
const agentcore = (): BedrockAgentCoreClient => (_agentcore ??= new BedrockAgentCoreClient({ region: config.region }));
const bedrock = (): BedrockRuntimeClient => (_bedrock ??= new BedrockRuntimeClient({}));

export interface TestCase {
  testId: string;
  agentId: string;
  prompt: string;
  referenceOutput: string | null;
  expectedTags: string[];
  /**
   * Set when `expected_tags` could not be parsed, so `expectedTags` above is a
   * fallback and not the case's real expectation. Null or absent on a case that
   * was read cleanly — including one that genuinely expects no tags.
   *
   * Optional so a hand-built case (a test, a future in-memory suite) does not
   * have to assert an absence; `loadCasesForRun` always sets it explicitly.
   */
  expectationProblem?: string | null;
  rubricOverride: string | null;
  passThreshold: number;
}

export interface CaseOutcome {
  testId: string;
  passed: boolean;
  judgeScore: number | null;
  judgeRationale: string | null;
  tagHits: Record<string, boolean>;
  referenceSimilarity: number | null;
  responseSnippet: string;
  failReasons: string[];
  durationMs: number;
}

export interface RunReport {
  runId: string;
  status: 'done' | 'failed';
  total: number;
  passed: number;
  failed: number;
  errors: number;
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export async function loadCasesForRun(agentId?: string): Promise<TestCase[]> {
  const rows = await exec(
    `SELECT test_id, agent_id, prompt, reference_output,
            expected_tags::text AS expected_tags, rubric_override, pass_threshold
       FROM observability.test_cases
      WHERE active = true
        ${agentId ? 'AND agent_id = :agent' : ''}
      ORDER BY agent_id, test_id
      LIMIT ${MAX_CASES_PER_RUN}`,
    agentId ? [s('agent', agentId)] : [],
  );
  return rows.map((r) => ({
    testId: toStr(r['test_id']),
    agentId: toStr(r['agent_id']),
    prompt: toStr(r['prompt']),
    referenceOutput: r['reference_output'] ? toStr(r['reference_output']) : null,
    ...readExpectedTags(r['expected_tags']),
    rubricOverride: r['rubric_override'] ? toStr(r['rubric_override']) : null,
    passThreshold: Number(r['pass_threshold'] ?? 0.7),
  }));
}

/**
 * `expected_tags` as a list, and whether that list is the case's expectation.
 *
 * THE SILENT PASS. This was an inline `catch { return []; }`. A malformed
 * `expected_tags` therefore became "this case expects no tags", `checkTags`
 * found nothing missing, and a case written to REQUIRE that the answer mention
 * Aurora and pgvector was quietly relaxed into one that requires nothing — and
 * then reported as **passed**. An evaluation harness scoring a green run off
 * an expectation it could not read is the worst failure mode this file has,
 * because the whole point of it is to be the thing that notices.
 *
 * The empty list is still what it hands back — there is no better guess — but
 * it says so, and `runCase` refuses to pass a case whose expectation is
 * unreadable. Note the two are distinguishable: `expected_tags` of `[]` is a
 * perfectly ordinary case that expects no particular vocabulary, and it parses
 * fine and carries no problem.
 */
function readExpectedTags(raw: unknown): { expectedTags: string[]; expectationProblem: string | null } {
  const text = toStr(raw, '[]');
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) return { expectedTags: parsed.map(String), expectationProblem: null };
    return {
      expectedTags: [],
      expectationProblem: `expected_tags is ${typeof parsed}, not a list`,
    };
  } catch (err) {
    return { expectedTags: [], expectationProblem: firstLine(err, 'expected_tags is not valid JSON') };
  }
}

// ── Deterministic checks ─────────────────────────────────────────────────────

/**
 * Which expected tags actually appear in the answer.
 *
 * Case-insensitive substring, because a tag is a required concept ("Aurora",
 * "pgvector") rather than an exact token, and an evaluation that fails on
 * capitalisation teaches you nothing.
 */
export function checkTags(answer: string, expected: string[]): Record<string, boolean> {
  const hay = answer.toLowerCase();
  const hits: Record<string, boolean> = {};
  for (const tag of expected) hits[tag] = hay.includes(tag.toLowerCase());
  return hits;
}

/**
 * Rough overlap with the reference answer, as a 0–1 Jaccard over word sets.
 *
 * Deliberately NOT an embedding call: this is a cheap signal for "did it talk
 * about the same things", it runs on every case, and calling it similarity
 * rather than correctness keeps it honest. The judge handles meaning.
 */
export function referenceSimilarity(answer: string, reference: string | null): number | null {
  if (!reference) return null;
  const words = (t: string): Set<string> =>
    new Set(t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  const a = words(answer);
  const b = words(reference);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return Number((shared / (a.size + b.size - shared)).toFixed(3));
}

// ── Agent invocation ─────────────────────────────────────────────────────────

/** Agents answer in several envelope shapes; pull out the text. */
export function extractAnswer(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return trimmed;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
    const o = parsed as Record<string, unknown>;
    for (const key of ['result', 'output', 'response', 'answer', 'text', 'message']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return trimmed;
  } catch { return trimmed; }
}

async function invokeAgent(agentId: string, prompt: string): Promise<{ answer: string; durationMs: number }> {
  const arn = await getRuntimeArn(agentId);
  if (!arn) throw new Error(`no deployed runtime for agent '${agentId}'`);
  const t0 = Date.now();
  const out = await agentcore().send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: arn,
    qualifier: 'DEFAULT',
    payload: new TextEncoder().encode(JSON.stringify({ prompt })),
  }));
  const stream = out.response as unknown as { transformToString: () => Promise<string> } | undefined;
  const text = stream ? await stream.transformToString() : '';
  return { answer: extractAnswer(text), durationMs: Date.now() - t0 };
}

// ── Judge ────────────────────────────────────────────────────────────────────

/**
 * Score an answer against the operator's rubric.
 *
 * Deliberately NOT lib/judge.ts's judgeResponse(). That one pins a fixed
 * system prompt, a fixed model and a fixed set of criteria, which is right for
 * scoring ad-hoc production traffic. An evaluation run has to honour what the
 * operator configured on /iq/evaluations — rubric dimensions and their
 * weights, the chosen judge model — plus the case's own rubric_override and
 * reference answer. Collapsing the two would quietly make the rubric editor
 * decorative, which is exactly the failure this work exists to remove.
 *
 * Returns null rather than throwing when the judge is unavailable — a run
 * whose judge is down should still report the deterministic checks instead of
 * failing wholesale.
 */
async function judge(
  testCase: TestCase,
  answer: string,
  modelId: string,
): Promise<{ score: number | null; rationale: string | null }> {
  const cfg = await getJudgeConfig().catch(() => null);
  const dims = cfg?.dimensions ?? [];
  if (dims.length === 0) return { score: null, rationale: null };

  const rubric = testCase.rubricOverride
    ?? dims.map((d) => `- ${d.key} (weight ${d.weight}): ${d.description ?? d.key}`).join('\n');

  const prompt = [
    'You are grading an AI agent answer against a rubric. Be strict and terse.',
    '',
    `QUESTION:\n${testCase.prompt}`,
    testCase.referenceOutput ? `\nREFERENCE ANSWER:\n${testCase.referenceOutput}` : '',
    `\nAGENT ANSWER:\n${answer.slice(0, 4000)}`,
    '',
    `RUBRIC:\n${rubric}`,
    '',
    'Score each rubric dimension from 0 to 10. Respond with JSON only:',
    `{"scores":{${dims.map((d) => `"${d.key}":0`).join(',')}},"rationale":"one sentence"}`,
  ].join('\n');

  try {
    const out = await bedrock().send(new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 600, temperature: 0 },
    }));
    const text = (out.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { score: null, rationale: null };
    const parsed = JSON.parse(text.slice(start, end + 1)) as {
      scores?: Record<string, number>; rationale?: string;
    };
    const composite = weightedComposite(parsed.scores ?? {}, dims);
    return {
      // Stored 0–1 to match pass_threshold's scale; the judge speaks 0–10.
      score: Number.isFinite(composite) ? Number((composite / 10).toFixed(3)) : null,
      rationale: typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 500) : null,
    };
  } catch (err) {
    console.warn('[harness] judge failed:', (err as Error).message);
    return { score: null, rationale: null };
  }
}

// ── One case ─────────────────────────────────────────────────────────────────

export async function runCase(testCase: TestCase, judgeModelId: string): Promise<CaseOutcome> {
  const failReasons: string[] = [];
  let answer = '';
  let durationMs = 0;

  // BEFORE the agent is invoked, and before the judge is paid: a case whose
  // expectation could not be read cannot produce a verdict about the agent, so
  // running it buys nothing and spends real Bedrock money to reach a result
  // that must be discarded anyway. It used to reach here as `expectedTags: []`
  // and be reported as a PASS.
  if (testCase.expectationProblem) {
    return {
      testId: testCase.testId,
      passed: false,
      judgeScore: null,
      judgeRationale: null,
      tagHits: {},
      referenceSimilarity: null,
      responseSnippet: '',
      failReasons: [`expectation unreadable: ${testCase.expectationProblem}`],
      durationMs: 0,
    };
  }

  try {
    const invoked = await invokeAgent(testCase.agentId, testCase.prompt);
    answer = invoked.answer;
    durationMs = invoked.durationMs;
  } catch (err) {
    // An agent that will not answer is the most important thing an evaluation
    // can report, so it is recorded as a failed case rather than raised.
    return {
      testId: testCase.testId,
      passed: false,
      judgeScore: null,
      judgeRationale: null,
      tagHits: {},
      referenceSimilarity: null,
      responseSnippet: '',
      failReasons: [`invocation failed: ${(err as Error).message}`],
      durationMs: 0,
    };
  }

  if (!answer.trim()) failReasons.push('agent returned an empty answer');

  const tagHits = checkTags(answer, testCase.expectedTags);
  const missing = Object.entries(tagHits).filter(([, hit]) => !hit).map(([tag]) => tag);
  if (missing.length > 0) failReasons.push(`missing expected: ${missing.join(', ')}`);

  const similarity = referenceSimilarity(answer, testCase.referenceOutput);
  const { score, rationale } = await judge(testCase, answer, judgeModelId);
  if (score !== null && score < testCase.passThreshold) {
    failReasons.push(`judge ${score.toFixed(2)} below threshold ${testCase.passThreshold}`);
  }

  return {
    testId: testCase.testId,
    // Deterministic checks are binding; the judge only fails a case when it
    // actually produced a score.
    passed: failReasons.length === 0,
    judgeScore: score,
    judgeRationale: rationale,
    tagHits,
    referenceSimilarity: similarity,
    responseSnippet: answer.slice(0, SNIPPET_CHARS),
    failReasons,
    durationMs,
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

export async function recordOutcome(runId: string, o: CaseOutcome): Promise<void> {
  await exec(
    `INSERT INTO observability.test_results
       (run_id, test_id, passed, judge_score, judge_rationale, tag_hits,
        reference_similarity, response_snippet, fail_reasons, duration_ms, ts)
     VALUES (CAST(:run_id AS uuid), :test_id, :passed, :score, NULLIF(:rationale,''),
             CAST(:tag_hits AS jsonb), :similarity, :snippet,
             CAST(:fail_reasons AS jsonb), :duration, now())
     ON CONFLICT (run_id, test_id) DO UPDATE SET
        passed = EXCLUDED.passed, judge_score = EXCLUDED.judge_score,
        judge_rationale = EXCLUDED.judge_rationale, tag_hits = EXCLUDED.tag_hits,
        reference_similarity = EXCLUDED.reference_similarity,
        response_snippet = EXCLUDED.response_snippet,
        fail_reasons = EXCLUDED.fail_reasons, duration_ms = EXCLUDED.duration_ms,
        ts = now()`,
    [
      s('run_id', runId), s('test_id', o.testId),
      { name: 'passed', value: { booleanValue: o.passed } },
      o.judgeScore == null ? { name: 'score', value: { isNull: true } } : n('score', o.judgeScore),
      s('rationale', o.judgeRationale ?? ''),
      s('tag_hits', JSON.stringify(o.tagHits)),
      o.referenceSimilarity == null
        ? { name: 'similarity', value: { isNull: true } }
        : n('similarity', o.referenceSimilarity),
      s('snippet', o.responseSnippet),
      s('fail_reasons', JSON.stringify(o.failReasons)),
      i('duration', o.durationMs),
    ],
  );
}

/** Recompute the run's counters from its results — never from a running tally. */
async function syncRunProgress(runId: string, status: string): Promise<void> {
  await exec(
    `UPDATE observability.test_runs r
        SET completed = c.total, passed = c.passed, failed = c.failed,
            pass_rate = CASE WHEN c.total > 0 THEN c.passed::numeric / c.total ELSE NULL END,
            status = :status,
            finished_at = CASE WHEN :status IN ('done','failed') THEN now() ELSE finished_at END
       FROM (
         SELECT count(*)::int AS total,
                count(*) FILTER (WHERE passed)::int AS passed,
                count(*) FILTER (WHERE NOT passed)::int AS failed
           FROM observability.test_results WHERE run_id = CAST(:run_id AS uuid)
       ) c
      WHERE r.run_id = CAST(:run_id AS uuid)`,
    [s('run_id', runId), s('status', status)],
  );
}

// ── The run ──────────────────────────────────────────────────────────────────

/**
 * Execute a run to completion.
 *
 * Counters are recomputed from the results table as cases land rather than
 * incremented, so a retried or re-run case can never double-count and a
 * mid-run refresh always shows a number that matches the rows.
 */
export async function executeRun(
  runId: string,
  opts: { agentId?: string; judgeModelId?: string } = {},
): Promise<RunReport> {
  const cases = await loadCasesForRun(opts.agentId);
  const judgeModelId = opts.judgeModelId ?? 'amazon.nova-pro-v1:0';

  await exec(
    `UPDATE observability.test_runs
        SET status = 'running', total_cases = :total, started_at = now()
      WHERE run_id = CAST(:run_id AS uuid)`,
    [s('run_id', runId), i('total', cases.length)],
  );

  if (cases.length === 0) {
    await syncRunProgress(runId, 'done');
    return { runId, status: 'done', total: 0, passed: 0, failed: 0, errors: 0 };
  }

  let cursor = 0;
  let errors = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const testCase = cases[index];
      if (!testCase) return;
      try {
        const outcome = await runCase(testCase, judgeModelId);
        // Both prefixes mean "this case did not produce a verdict about the
        // agent" — the agent would not answer, or the expectation could not be
        // read. Counting only the first made a suite full of corrupt rows
        // report zero errors.
        if (outcome.failReasons.some(
          (r) => r.startsWith('invocation failed') || r.startsWith('expectation unreadable'),
        )) errors++;
        await recordOutcome(runId, outcome);
      } catch (err) {
        // Recording failed (not the case itself) — log and keep going so one
        // bad write does not abandon the rest of the suite.
        console.warn(`[harness] could not record ${testCase.testId}:`, (err as Error).message);
      }
      await syncRunProgress(runId, 'running').catch(() => {});
    }
  };

  await Promise.all(Array.from({ length: Math.min(CASE_CONCURRENCY, cases.length) }, () => worker()));
  await syncRunProgress(runId, 'done');

  const rows = await exec(
    `SELECT count(*) FILTER (WHERE passed)::int AS passed,
            count(*) FILTER (WHERE NOT passed)::int AS failed
       FROM observability.test_results WHERE run_id = CAST(:run_id AS uuid)`,
    [s('run_id', runId)],
  );
  return {
    runId,
    status: 'done',
    total: cases.length,
    passed: Number(rows[0]?.['passed'] ?? 0),
    failed: Number(rows[0]?.['failed'] ?? 0),
    errors,
  };
}
