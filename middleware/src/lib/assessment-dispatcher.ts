import { config } from '../config.js';
import { agentcore } from '../providers/index.js';
import * as A from '../providers/assessment-aurora.js';
import { completeRun } from '../providers/assessment.js';
import { DECK_COMMANDS } from './assessment-run-input.js';
import { assessmentBroker } from './assessment-broker.js';
import type * as M from '../mock/assessment.js';

const SCORE_COMMANDS = new Set(['score-dimensions', 'process-self-assessment']);
let polling = false;
let timer: ReturnType<typeof setInterval> | undefined;

export function scoreResult(text: string, relevantDimensions?: unknown): M.ScoringLogEntry[] {
  const result: unknown = JSON.parse(text);
  if (!result || typeof result !== 'object' || !('scores' in result) || !Array.isArray(result.scores) || !result.scores.length) {
    throw new Error('Scorer returned no score envelope');
  }
  return result.scores.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('Malformed score result');
    const score = raw as Record<string, unknown>;
    if (score['refused'] || typeof score['dimension_id'] !== 'string'
      || !['low', 'moderate', 'high'].includes(String(score['confidence']))
      || typeof score['rationale'] !== 'string'
      || !Number.isInteger(score['current_level']) || Number(score['current_level']) < 0 || Number(score['current_level']) > 5) {
      throw new Error('Scorer returned an invalid or refused score');
    }
    if (Array.isArray(relevantDimensions) && !relevantDimensions.includes(score['dimension_id'])) throw new Error('Scorer returned an out-of-scope dimension');
    const strings = (key: string): string[] => {
      const value = score[key];
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`Invalid ${key}`);
      return value;
    };
    return {
      dimension_id: score['dimension_id'], is_na: false, na_claimed: score['na_claimed'] === true,
      suggested_level: score['current_level'] as number, confidence: score['confidence'] as M.Confidence,
      rationale: score['rationale'], evidence_excerpts: strings('evidence_excerpts'),
      follow_up_questions: strings('follow_up_questions'),
      self_claimed_level: score['self_claimed_level'] == null ? null : score['self_claimed_level'] as number,
      evidence_class: score['evidence_class'] as M.EvidenceClass | null,
      cap_applied: score['cap_applied'] === true,
    };
  });
}

export async function dispatchAssessmentRuns(): Promise<void> {
  if (config.mock.aurora || config.mock.agentcore || process.env['DEV_OFFLINE'] === 'true' || polling) return;
  polling = true;
  try {
    for (const run of await A.expireAssessmentClaims()) {
      assessmentBroker.publish({ type: 'run.failed', run_id: run.id, command: run.command,
        team_id: run.team_id, reason: run.error ?? 'Worker lease expired', ts: run.finished_at! });
    }
    // Every process claims at most the global admission cap; SQL owns the
    // cross-process exclusion. Fire each claim independently, so one long
    // invocation cannot prevent other runs from making progress.
    for (let i = 0; i < 3; i++) {
      const claimed = await A.claimAssessmentRun();
      if (!claimed) break;
      void executeClaim(claimed).catch(error => console.error('[assessment] terminal persistence failed:', error));
    }
  } finally { polling = false; }
}

export async function executeClaim(claimed: NonNullable<Awaited<ReturnType<typeof A.claimAssessmentRun>>>): Promise<void> {
  const { run, dispatch } = claimed;
  try {
    const result = await agentcore.invokeAgent(dispatch.agentId, {
      message: `Execute assessment command ${run.command}`,
      structuredInput: { ...dispatch.payload, run_id: run.id },
      timeoutMs: 15 * 60_000,
    });
    if (result.raw && typeof result.raw === 'object' && 'error' in result.raw) {
      throw new Error(String(result.raw.error));
    }
    if (!result.text.trim()) throw new Error('Agent returned an empty result');
    const scoringLog = SCORE_COMMANDS.has(run.command) ? scoreResult(result.text, dispatch.payload['relevant_dimension_ids']) : undefined;
    // A review-deck run's output is the drafter's JSON; the deck provider
    // merges it (and writes the revision) inside completeRun.
    const deckResult: unknown = DECK_COMMANDS.has(run.command) ? JSON.parse(result.text) : undefined;
    const completed = await completeRun(run.id, { status: 'completed',
      ...(scoringLog ? { scoring_log: scoringLog } : deckResult !== undefined ? { deck_result: deckResult } : { summary: result.text }) });
    if (!completed.ok && completed.status !== 409) throw new Error(completed.reason);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Agent dispatch failed';
    await completeRun(run.id, { status: 'failed', error: reason });
  }
}

export function startAssessmentDispatcher(): void {
  if (timer || config.mock.aurora || config.mock.agentcore || process.env['DEV_OFFLINE'] === 'true') return;
  const tick = () => { void dispatchAssessmentRuns().catch(error => console.warn('[assessment] dispatch failed:', error)); };
  timer = setInterval(tick, 5_000);
  timer.unref();
  tick();
}
