// The independent reviewer — a second opinion on agent-written code.
//
// The governance premise is that a change is not trustworthy just because an
// agent produced it. So before a change can ship, a *different* model reads the
// diff and judges it, exactly as a human reviewer would read a pull request:
// is it correct, is it scoped to what was asked, does it introduce anything
// obviously wrong.
//
// Reviewing a captured diff is a text judgment, not a filesystem task, so this
// is a direct Converse call over the stored diff rather than another devbox
// run. That keeps a review cheap, fast, and free of the workspace lifecycle —
// the diff was captured precisely so a review does not depend on the workspace
// still existing.

import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { config } from '../config.js';
import { staticReview } from '../mock/static-review.js';
import type { ReviewVerdict } from './sdlc-policy.js';

const REVIEW_MODEL = process.env['SDLC_REVIEW_MODEL_ID'] ?? 'amazon.nova-pro-v1:0';

let _client: BedrockRuntimeClient | null = null;
const client = (): BedrockRuntimeClient => (_client ??= new BedrockRuntimeClient({ region: config.region }));

export interface ReviewFinding {
  severity: 'high' | 'medium' | 'low';
  file?: string;
  line?: number;
  note: string;
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  model: string;
}

const SYSTEM = [
  'You are a senior engineer reviewing a code change an AI agent produced, before it can be merged.',
  'You are the last check between the agent and the repository, so be skeptical and concrete.',
  '',
  'Judge three things:',
  '  1. Correctness — does the change do what the task asked, without bugs?',
  '  2. Scope — is it limited to the task, or does it touch unrelated things?',
  '  3. Safety — does it remove a safeguard, weaken auth, leak a secret, or break a contract?',
  '',
  'Return a verdict:',
  '  approve          — correct, in scope, safe. Ship it.',
  '  request_changes  — fixable problems; say exactly what to change.',
  '  reject           — wrong approach, or unsafe in a way revision will not fix.',
  '',
  'Reply with JSON only, no prose around it:',
  '{"verdict":"approve|request_changes|reject","summary":"one or two sentences","findings":[{"severity":"high|medium|low","file":"path","line":0,"note":"the concrete objection"}]}',
].join('\n');

function coerceVerdict(v: unknown): ReviewVerdict {
  return v === 'approve' || v === 'reject' ? v : 'request_changes';
}

/**
 * Review a diff.
 *
 * A review that cannot be produced does not silently pass — an unreadable
 * model response, a truncated diff, a thrown call all resolve to
 * `request_changes` with the reason, so the failure mode of the reviewer is to
 * ask for a human rather than to wave the change through. The whole point of
 * the gate is defeated if "the reviewer errored" reads as "approved".
 */
export async function reviewDiff(input: {
  title: string; diff: string; truncated: boolean; taskPrompt?: string | null;
}): Promise<ReviewResult> {
  if (!input.diff.trim()) {
    return { verdict: 'reject', summary: 'The change is empty — there is nothing to review.', findings: [], model: REVIEW_MODEL };
  }

  // Offline: a real reading of this diff, not a canned verdict and not the
  // Bedrock failure below dressed up as one. `mock/static-review.ts` scans the
  // added and removed lines for committed credentials, removed guards, skipped
  // tests and debug output, and its verdict then flows into the real
  // `evaluate()` unchanged — so the gates and the resulting status are genuine
  // engine output, exactly as `mock/sdlc.ts` derives its seeded statuses.
  //
  // NOTE the placement. This branch is above the `try`, not inside its
  // `catch`: the catch is the outage path, and it must keep degrading to
  // `request_changes` in real mode. A mock branch that softened it would turn
  // "the reviewer could not run" into "the reviewer approved", which is the
  // one thing a governance gate must never do.
  if (config.mock.agentcore) {
    const out = staticReview({ title: input.title, diff: input.diff, truncated: input.truncated });
    return { verdict: out.verdict, summary: out.summary, findings: out.findings, model: out.model };
  }

  const user = [
    `Task the agent was given: ${input.taskPrompt ?? '(not recorded)'}`,
    `Change title: ${input.title}`,
    input.truncated ? 'NOTE: the diff below was truncated for size; judge what you can and flag the size.' : '',
    '',
    'Diff:',
    '```diff',
    input.diff,
    '```',
  ].filter(Boolean).join('\n');

  try {
    const out = await client().send(new ConverseCommand({
      modelId: REVIEW_MODEL,
      system: [{ text: SYSTEM }],
      messages: [{ role: 'user', content: [{ text: user }] }],
      inferenceConfig: { maxTokens: 1500, temperature: 0.2 },
    }));
    const text = out.output?.message?.content?.[0]?.text ?? '';
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    if (!json) {
      return { verdict: 'request_changes', summary: 'The reviewer returned no usable verdict — a human should look.', findings: [], model: REVIEW_MODEL };
    }
    const parsed = JSON.parse(json) as { verdict?: unknown; summary?: unknown; findings?: unknown };
    const findings = Array.isArray(parsed.findings)
      ? parsed.findings.slice(0, 30).map((f): ReviewFinding => ({
          severity: (f?.severity === 'high' || f?.severity === 'low') ? f.severity : 'medium',
          ...(typeof f?.file === 'string' ? { file: f.file } : {}),
          ...(typeof f?.line === 'number' ? { line: f.line } : {}),
          note: typeof f?.note === 'string' ? f.note : String(f?.note ?? ''),
        }))
      : [];
    return {
      verdict: coerceVerdict(parsed.verdict),
      summary: typeof parsed.summary === 'string' ? parsed.summary : 'No summary provided.',
      findings,
      model: REVIEW_MODEL,
    };
  } catch (err) {
    return {
      verdict: 'request_changes',
      summary: `The review could not be completed (${(err as Error).message}) — sending to a human.`,
      findings: [],
      model: REVIEW_MODEL,
    };
  }
}
