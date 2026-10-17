// The facts half of a pipeline run report deck (docs/agentic-flows-migration.md,
// slice 3). Same rule as the assessment review deck: numbers never come from
// the model. Every count, duration, cost and status below is read from the run
// projection (lib/pipeline-runs.ts `Run` / `Step` / `Artifact`) plus the
// pending approvals that name the run, and laid out into the vendored DeckSpec.
// The drafter writes only the prose part of the summary and failures slides.
//
// It reuses the assessment deck's `SlidePlan` / `makePlan` / `mergeDraft`
// machinery (lib/assessment-deck), which is generic over slide kinds: only the
// plan builder differs. `buildPipelineDraftInput` is the drafter's input for
// the `pipeline-run-deck` command (it checks only slideId/facts/
// evidence, not slide kinds).

import {
  MAX_BULLETS_PER_SLIDE, MAX_SOURCES_PER_SLIDE, MAX_TITLE_CHARS,
  type DeckSource,
} from '@connorhoehn/realtime-modules/deck';
import { clip, makePlan, type DeckEvidence, type DeckFacts, type FactValue, type SlidePlan } from '../deck-shared/plan.js';
import type { DraftDeckInput } from '../deck-shared/narrative.js';
import type { Artifact, Run, Step } from '../pipeline-runs.js';
import type { ApprovalRequest } from '../pipeline-definitions.js';

export interface RunDeckSource {
  run: Run;
  steps: readonly Step[];
  artifacts: readonly Artifact[];
  /** Pending approval requests naming this run (the tenant keeps no history). */
  approvals: readonly ApprovalRequest[];
}

export const RUN_NARRATIVE_KINDS: ReadonlySet<string> = new Set(['run-summary', 'run-failures']);

const MAX_LISTED = MAX_BULLETS_PER_SLIDE - 1;
const EXCERPT_CHARS = 600;

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

const ms = (from: string | null, to: string | null): number | null => {
  if (!from || !to) return null;
  const d = Date.parse(to) - Date.parse(from);
  return Number.isFinite(d) && d >= 0 ? d : null;
};

/** "340 ms", "12.5 s", "1m 05s", "2h 03m". Deterministic. */
export function formatDuration(durationMs: number): string {
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const s = durationMs / 1000;
  if (s < 60) return `${Math.round(s * 10) / 10} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const seconds = (durationMs: number): number => Math.round(durationMs / 100) / 10;
const dollars = (v: number): string => `$${v.toFixed(4)}`;
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : 'not recorded');

function lines(all: string[], noun: string): string[] {
  if (all.length <= MAX_BULLETS_PER_SLIDE) return all.map((l) => clip(l));
  return [...all.slice(0, MAX_LISTED).map((l) => clip(l)), `…and ${all.length - MAX_LISTED} more ${noun}`];
}

const runSource = (run: Run): DeckSource => ({ documentId: `pipeline-run:${run.id}`, title: clip(`Run ${run.id} — ${run.context.title}`, 160) });
const stepSource = (run: Run, step: Step): DeckSource => ({ documentId: `pipeline-run:${run.id}:step:${step.stepId}`, title: clip(`Step ${step.label}`, 160) });

export function buildRunDeckFacts(src: RunDeckSource, options: { title?: string } = {}): DeckFacts {
  const { run, steps, artifacts, approvals } = src;
  const runSrc = runSource(run);
  const count = (status: Step['status']) => steps.filter((s) => s.status === status).length;
  const failed = steps.filter((s) => s.status === 'failed');
  const totalMs = ms(run.startedAt, run.finishedAt);
  const stepMs = (s: Step) => ms(s.startedAt, s.finishedAt);
  const slides: SlidePlan[] = [];

  const errorText = run.context.error?.trim() || '';
  const evidenceOf = (items: Array<{ id: string; text: string | null | undefined }>): DeckEvidence[] =>
    items.filter((e): e is { id: string; text: string } => !!e.text?.trim())
      .map((e) => ({ id: e.id, excerpt: e.text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS) }));
  const failureEvidence = evidenceOf([
    { id: `run:${run.id}:error`, text: errorText },
    ...failed.map((s) => ({ id: `step:${s.stepId}`, text: s.detail })),
  ]);

  // 1. Title
  {
    const facts: Record<string, FactValue> = {
      run: run.id, definition: run.definitionId, status: run.status, context: run.context.tenant, started: day(run.startedAt),
    };
    slides.push(makePlan({
      slideId: 'title', kind: 'run-title', facts, evidence: [], prose: 'none', maxProse: 0,
      factBullets: [`Run: ${run.id}`, `Definition: ${run.definitionId}`, `Status: ${run.status}`, `Started: ${day(run.startedAt)}`, `Finished: ${day(run.finishedAt)}`],
      templateProse: [], templateNotes: `Run report for ${run.id}, prepared from the run projection.`,
    }, { id: 'title', layout: 'title', title: clip(run.context.title || run.id, MAX_TITLE_CHARS), eyebrow: 'Pipeline run report', sources: [runSrc] }));
  }

  // 2. Summary
  {
    const other = steps.length - count('completed') - count('failed') - count('skipped');
    const facts: Record<string, FactValue> = {
      status: run.status, stepsTotal: steps.length, stepsCompleted: count('completed'), stepsFailed: count('failed'),
      stepsSkipped: count('skipped'), stepsOther: other, approvalsPending: approvals.length, artifacts: artifacts.length,
      duration: totalMs === null ? 'not recorded' : formatDuration(totalMs),
      costUsd: run.costUsd === null ? 'not recorded' : dollars(run.costUsd),
    };
    const factBullets = [
      `Status: ${run.status}`,
      `Steps: ${steps.length} total · ${count('completed')} completed · ${count('failed')} failed · ${count('skipped')} skipped · ${other} other`,
      `Duration: ${facts['duration']}`,
      `Cost: ${facts['costUsd']}`,
      `Pending approvals: ${approvals.length}`,
      `Artifacts: ${artifacts.length}`,
    ];
    slides.push(makePlan({
      slideId: 'summary', kind: 'run-summary', facts,
      evidence: evidenceOf([{ id: `run:${run.id}:title`, text: run.context.title }, ...failureEvidence.map((e) => ({ id: e.id, text: e.excerpt }))]).slice(0, 6),
      prose: 'bullets', maxProse: MAX_BULLETS_PER_SLIDE - factBullets.length, factBullets,
      templateProse: [clip(`Run ${run.status}${failed.length ? '; see the failures slide.' : '.'}`)],
    }, { id: 'summary', layout: 'bullets', title: 'Summary', sources: [runSrc] }));
  }

  // 3. Step durations chart
  const timed = steps.map((s) => ({ s, d: stepMs(s) })).filter((x): x is { s: Step; d: number } => x.d !== null).slice(0, 24);
  if (timed.length) {
    slides.push(makePlan({
      slideId: 'timeline', kind: 'run-timeline', facts: { timedSteps: timed.length }, evidence: [], prose: 'none', maxProse: 0,
      factBullets: [`Duration in seconds of ${plural(timed.length, 'step')} with recorded start and finish times`], templateProse: [],
    }, {
      id: 'timeline', layout: 'chart', title: 'Step durations', sources: [runSrc],
      chart: { kind: 'bar', labels: timed.map((x) => clip(x.s.label, 40)), series: [{ name: 'Seconds', values: timed.map((x) => seconds(x.d)) }] },
    }));
  }

  // 4. Step list
  {
    const rows = steps.map((s) => {
      const d = stepMs(s);
      return `${s.label} — ${s.status}${s.attempts.length > 1 ? ` (${s.attempts.length} attempts)` : ''} · ${d === null ? 'duration not recorded' : formatDuration(d)}`;
    });
    slides.push(makePlan({
      slideId: 'steps', kind: 'run-steps', facts: { stepsTotal: steps.length }, evidence: [], prose: 'none', maxProse: 0,
      factBullets: rows.length ? lines(rows, 'steps') : ['No steps were recorded for this run.'], templateProse: [],
    }, {
      id: 'steps', layout: 'bullets', title: 'Steps', sources: [runSrc, ...steps.slice(0, MAX_SOURCES_PER_SLIDE - 1).map((s) => stepSource(run, s))],
    }));
  }

  // 5. Approvals
  const approvalSteps = steps.filter((s) => s.status === 'awaiting_approval');
  if (approvals.length || approvalSteps.length) {
    const rows = approvals.length
      ? approvals.map((a) => `${a.title} — needs ${a.requiredRoles.join(' or ') || 'an approver'}${a.requestedAt ? ` · asked ${day(a.requestedAt)}` : ''}`)
      : approvalSteps.map((s) => `${s.label} — awaiting approval`);
    slides.push(makePlan({
      slideId: 'approvals', kind: 'run-approvals', facts: { approvalsPending: approvals.length, stepsAwaiting: approvalSteps.length },
      evidence: [], prose: 'none', maxProse: 0, factBullets: lines(rows, 'approvals'), templateProse: [],
    }, { id: 'approvals', layout: 'bullets', title: 'Approvals', sources: [runSrc] }));
  }

  // 6. Artifacts
  if (artifacts.length) {
    slides.push(makePlan({
      slideId: 'artifacts', kind: 'run-artifacts', facts: { artifacts: artifacts.length }, evidence: [], prose: 'none', maxProse: 0,
      factBullets: lines(artifacts.map((a) => `${a.kind}: ${a.title}`), 'artifacts'), templateProse: [],
    }, {
      id: 'artifacts', layout: 'bullets', title: 'Artifacts',
      sources: [runSrc, ...artifacts.slice(0, MAX_SOURCES_PER_SLIDE - 1).map((a) => ({ documentId: `pipeline-artifact:${a.id}`, title: clip(`Artifact ${a.title}`, 160) }))],
    }));
  }

  // 7. Failures
  if (failed.length || errorText) {
    const rows = [
      ...(errorText ? [`Run error: ${errorText}`] : []),
      ...failed.map((s) => `${s.label}${s.detail ? `: ${s.detail}` : ' — failed'}`),
    ];
    const factBullets = lines(rows, 'failures').slice(0, MAX_BULLETS_PER_SLIDE - 2);
    slides.push(makePlan({
      slideId: 'failures', kind: 'run-failures', facts: { stepsFailed: failed.length, error: errorText ? clip(errorText, 200) : 'none recorded' },
      evidence: failureEvidence.slice(0, 6), prose: 'bullets', maxProse: MAX_BULLETS_PER_SLIDE - factBullets.length, factBullets,
      templateProse: ['The recorded detail above is what the run reported.'],
    }, {
      id: 'failures', layout: 'bullets', title: 'Failures',
      sources: [runSrc, ...failed.slice(0, MAX_SOURCES_PER_SLIDE - 1).map((s) => stepSource(run, s))],
    }));
  }

  const title = clip(options.title?.trim() || `${run.context.title || run.id} — run report`, MAX_TITLE_CHARS);
  const subtitle = clip(`${run.definitionId} · ${run.status} · ${day(run.startedAt)}`, 200);
  return { teamId: run.id, slides, spec: { title, subtitle, theme: 'plain', slides: slides.map((s) => s.base) } };
}

/** The drafter's input for `pipeline-run-deck`: `teamId` carries the run id. */
export function buildRunDraftInput(facts: DeckFacts): DraftDeckInput {
  return {
    teamId: facts.teamId,
    slides: facts.slides.filter((s) => RUN_NARRATIVE_KINDS.has(s.kind)).map((s) => ({
      slideId: s.slideId, kind: s.kind, facts: s.facts, evidence: s.evidence,
    })),
  };
}
