// The facts half of an orgiq initiative status deck (docs/agentic-flows-migration.md,
// slice 6). Same rule as the assessment and pipeline run decks: numbers never
// come from the model. Every count, point total, dollar figure, date and status
// below is read from the initiative's own rows (work items, sprints, decisions,
// the budget ledger, sprint envelopes and the 30-day maintenance floor) and laid
// out into the vendored DeckSpec. The drafter writes only the prose half of the
// summary and decisions slides.
//
// BUDGET TIER. `source.budget` and `source.grants` are null unless the caller
// may read the budgets surface (org-leader / hr-admin / program-owner / admin,
// or ManageBudgets — routes/budgets.ts `readGate`). With them null this module
// emits NO allocation, spend, envelope or maintenance-floor slide and no such
// figure on any other slide: redaction is by omission, so there is nothing for a
// later edit or a narrative to leak. What stays for every orgiq reader is the
// planning estimate on work items (`estimated_cost_usd`), which the work board
// already shows to every role.
//
// It reuses the assessment deck's `SlidePlan` / `makePlan` / `mergeDraft`
// machinery; `buildInitiativeDraftInput` feeds the `initiative-status-deck`
// command (`teamId` carries the initiative id).

import {
  MAX_BULLETS_PER_SLIDE, MAX_SOURCES_PER_SLIDE, MAX_TITLE_CHARS, type DeckSource,
} from '@connorhoehn/realtime-modules/deck';
import { clip, makePlan, type DeckEvidence, type DeckFacts, type FactValue, type SlidePlan } from '../deck-shared/plan.js';
import type { DraftDeckInput } from '../deck-shared/narrative.js';
import { briefLine, windowLabel, type DeckBrief } from './brief.js';
import type { WorkItem, ProjectDecision } from '../../providers/work-items.js';
import type { SprintRow } from '../../providers/sprints.js';
import type { GrantRow } from '../../providers/budgets.js';

export interface InitiativeBudgetFacts {
  period: string | null;
  allocatedUsd: number | null;
  spentThisPeriodUsd: number;
  runCountThisPeriod: number;
  /** Cron spend over the trailing 30 days (v_initiative_maintenance_30d). */
  maintenance30dUsd: number;
  cronRuns30d: number;
}

export interface InitiativeDeckSource {
  project: {
    id: string; name: string; status: string | null; summary: string | null;
    ownerName: string | null; sponsorName: string | null; repoFullName: string | null;
  };
  /** YYYY-MM-DD the facts were read. */
  asOf: string;
  workItems: readonly WorkItem[];
  sprints: readonly SprintRow[];
  decisions: readonly ProjectDecision[];
  /** Null when the caller cannot read budgets. */
  budget: InitiativeBudgetFacts | null;
  grants: readonly GrantRow[] | null;
}

export const INITIATIVE_NARRATIVE_KINDS: ReadonlySet<string> = new Set(['initiative-summary', 'initiative-decisions']);

const MAX_LISTED = MAX_BULLETS_PER_SLIDE - 1;
const EXCERPT_CHARS = 600;
export const STATUS_ORDER = ['open', 'in_progress', 'in_review', 'done', 'cancelled'] as const;
const STATUS_LABEL: Record<string, string> = {
  open: 'Open', in_progress: 'In progress', in_review: 'In review', done: 'Done', cancelled: 'Cancelled',
};
const TYPE_ORDER = ['epic', 'story', 'bug'] as const;

export const money = (v: number): string => `$${v.toFixed(2)}`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const sum = (xs: Iterable<number | null | undefined>): number => {
  let t = 0;
  for (const x of xs) if (typeof x === 'number' && Number.isFinite(x)) t += x;
  return Math.round(t * 10_000) / 10_000;
};
const day = (iso: string | null): string => (iso ? iso.slice(0, 10) : 'not set');

function lines(all: string[], noun: string): string[] {
  if (all.length <= MAX_BULLETS_PER_SLIDE) return all.map((l) => clip(l));
  return [...all.slice(0, MAX_LISTED).map((l) => clip(l)), `…and ${all.length - MAX_LISTED} more ${noun}`];
}

/** Open means neither done nor cancelled. */
/** The initiative page's wording for a status: `in_progress` reads "In Progress". */
export const statusLabel = (v: string | null | undefined, fallback: string): string =>
  v ? v.split(/[_\s]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : fallback;

export const isOpenItem = (i: Pick<WorkItem, 'status'>): boolean => i.status !== 'done' && i.status !== 'cancelled';

const projectSource = (p: InitiativeDeckSource['project']): DeckSource => ({ documentId: `initiative:${p.id}`, title: clip(`Initiative ${p.name}`, 160) });
const boardSource = (p: InitiativeDeckSource['project']): DeckSource => ({ documentId: `initiative:${p.id}:work-items`, title: clip(`${p.name} — work items`, 160) });

/**
 * `options.brief` (G55) is the requester's words and the sprint window they
 * selected (brief.ts): it adds the window sprint's own numbers to the summary
 * slide's facts (so the prose may cite them), names the window in the subtitle
 * and quotes the words in the title slide's notes. Every other slide, and every
 * number, is the record's as before.
 */
export function buildInitiativeDeckFacts(src: InitiativeDeckSource, options: { title?: string; brief?: DeckBrief | null } = {}): DeckFacts {
  const { project, workItems, sprints, decisions, budget, grants } = src;
  const brief = options.brief ?? null;
  const focus = brief?.window ? sprints.find((s) => s.id === brief.window!.sprintId) ?? null : null;
  const initSrc = projectSource(project);
  const boardSrc = boardSource(project);
  const slides: SlidePlan[] = [];

  const items = workItems;
  const open = items.filter(isOpenItem);
  const byStatus = (s: string) => items.filter((i) => i.status === s);
  const pointsTotal = sum(items.filter((i) => i.status !== 'cancelled').map((i) => i.storyPoints));
  const pointsDone = sum(byStatus('done').map((i) => i.storyPoints));
  const openEstimate = sum(open.map((i) => i.estimatedCostUsd));
  const openDecisions = decisions.filter((d) => d.status === 'open' || d.status === 'escalated');
  const evidenceOf = (list: Array<{ id: string; text: string | null | undefined }>): DeckEvidence[] =>
    list.filter((e): e is { id: string; text: string } => !!e.text?.trim())
      .map((e) => ({ id: e.id, excerpt: e.text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS) }));

  // 1. Title
  slides.push(makePlan({
    slideId: 'title', kind: 'initiative-title',
    facts: { initiative: project.id, status: statusLabel(project.status, 'not set'), asOf: src.asOf },
    evidence: [], prose: 'none', maxProse: 0,
    factBullets: [
      `Status: ${statusLabel(project.status, 'not set')}`,
      `Owner: ${project.ownerName ?? 'not assigned'}`,
      ...(project.sponsorName ? [`Sponsor: ${project.sponsorName}`] : []),
      ...(project.repoFullName ? [`Repository: ${project.repoFullName}`] : []),
      `As of: ${src.asOf}`,
    ],
    templateProse: [], templateNotes: `Status deck for ${project.name}, prepared from the initiative's work items, sprints and decisions.${brief ? ` ${briefLine(brief)}` : ''}`,
  }, { id: 'title', layout: 'title', title: clip(project.name, MAX_TITLE_CHARS), eyebrow: 'Initiative status', sources: [initSrc] }));

  // 2. Summary
  {
    const facts: Record<string, FactValue> = {
      workItems: items.length, open: open.length, done: byStatus('done').length,
      pointsDone, pointsTotal, openEstimateUsd: money(openEstimate),
      sprints: sprints.length, openDecisions: openDecisions.length,
      // The window the brief selected: that sprint's own row, nothing computed from the words.
      ...(focus ? {
        focusSprint: focus.name, focusStartsOn: day(focus.startsOn), focusEndsOn: day(focus.endsOn), focusStatus: statusLabel(focus.status, 'no status'),
        focusItemsDone: focus.doneItemCount, focusItems: focus.itemCount, focusPointsDone: focus.pointsDone, focusPointsTotal: focus.pointsTotal,
      } : {}),
    };
    const factBullets = [
      `Work items: ${items.length} total · ${open.length} open · ${byStatus('done').length} done`,
      `Story points: ${pointsDone} of ${pointsTotal} done`,
      `Estimated cost of open work: ${money(openEstimate)}`,
      `Sprints: ${sprints.length}`,
      `Open decisions: ${openDecisions.length}`,
    ];
    const blocked = open.filter((i) => i.blockedReason?.trim());
    slides.push(makePlan({
      slideId: 'summary', kind: 'initiative-summary', facts,
      evidence: evidenceOf([
        { id: `initiative:${project.id}:summary`, text: project.summary },
        ...blocked.map((i) => ({ id: `work:${i.id}:blocked`, text: `${i.title}: ${i.blockedReason}` })),
      ]).slice(0, 6),
      prose: 'bullets', maxProse: MAX_BULLETS_PER_SLIDE - factBullets.length, factBullets,
      templateProse: [clip(project.summary?.trim() || `${project.name} is ${project.status ?? 'in flight'}.`)],
    }, { id: 'summary', layout: 'bullets', title: 'Summary', sources: [initSrc, boardSrc] }));
  }

  // 3. Work by status (chart)
  slides.push(makePlan({
    slideId: 'work-status', kind: 'initiative-work-status', facts: { workItems: items.length }, evidence: [], prose: 'none', maxProse: 0,
    factBullets: [`Count of work items in each status (${plural(items.length, 'item')})`], templateProse: [],
  }, {
    id: 'work-status', layout: 'chart', title: 'Work by status', sources: [boardSrc],
    chart: {
      kind: 'bar', labels: STATUS_ORDER.map((s) => STATUS_LABEL[s]!),
      series: [{ name: 'Work items', values: STATUS_ORDER.map((s) => byStatus(s).length) }],
    },
  }));

  // 4. Work by type
  {
    const rows = TYPE_ORDER.map((t) => {
      const of = items.filter((i) => i.type === t);
      const pts = sum(of.map((i) => i.storyPoints));
      const est = sum(of.map((i) => i.estimatedCostUsd));
      return `${t === 'bug' ? 'Bugs' : t === 'epic' ? 'Epics' : 'Stories'}: ${of.length} · ${of.filter(isOpenItem).length} open · ${pts} points · ${money(est)} estimated`;
    });
    slides.push(makePlan({
      slideId: 'work-type', kind: 'initiative-work-type', facts: { workItems: items.length }, evidence: [], prose: 'none', maxProse: 0,
      factBullets: rows, templateProse: [],
    }, { id: 'work-type', layout: 'bullets', title: 'Work by type', sources: [boardSrc] }));
  }

  // 5. Sprints
  if (sprints.length) {
    const rows = sprints.map((s) =>
      `${s.name} — ${statusLabel(s.status, 'no status')} · ${day(s.startsOn)} to ${day(s.endsOn)} · ${s.doneItemCount}/${s.itemCount} items · ${s.pointsDone}/${s.pointsTotal} points · ${money(s.estimatedCostUsd)} estimated`);
    slides.push(makePlan({
      slideId: 'sprints', kind: 'initiative-sprints', facts: { sprints: sprints.length }, evidence: [], prose: 'none', maxProse: 0,
      factBullets: lines(rows, 'sprints'), templateProse: [],
    }, {
      id: 'sprints', layout: 'bullets', title: 'Sprints',
      sources: [initSrc, ...sprints.slice(0, MAX_SOURCES_PER_SLIDE - 1).map((s) => ({ documentId: `sprint:${s.id}`, title: clip(`Sprint ${s.name}`, 160) }))],
    }));
  }

  // 6. Budget + maintenance floor (budget tier only)
  if (budget) {
    const remaining = budget.allocatedUsd === null ? null : Math.round((budget.allocatedUsd - budget.spentThisPeriodUsd) * 10_000) / 10_000;
    const floorShare = budget.allocatedUsd && budget.allocatedUsd > 0
      ? `${Math.round((budget.maintenance30dUsd / budget.allocatedUsd) * 1000) / 10}% of the monthly allocation`
      : 'no allocation to compare against';
    const factBullets = [
      `Monthly allocation: ${budget.allocatedUsd === null ? 'none set' : money(budget.allocatedUsd)}`,
      `Spent this period: ${money(budget.spentThisPeriodUsd)} across ${plural(budget.runCountThisPeriod, 'run')}`,
      `Remaining: ${remaining === null ? 'not applicable' : money(remaining)}`,
      `Maintenance floor, last 30 days: ${money(budget.maintenance30dUsd)} across ${plural(budget.cronRuns30d, 'cron run')}`,
      `Floor against allocation: ${floorShare}`,
    ];
    slides.push(makePlan({
      slideId: 'budget', kind: 'initiative-budget',
      facts: {
        allocatedUsd: budget.allocatedUsd === null ? 'none' : money(budget.allocatedUsd), spentUsd: money(budget.spentThisPeriodUsd),
        maintenanceUsd: money(budget.maintenance30dUsd),
      },
      evidence: [], prose: 'none', maxProse: 0, factBullets, templateProse: [],
    }, {
      id: 'budget', layout: 'bullets', title: 'Budget and maintenance floor',
      sources: [{ documentId: `initiative:${project.id}:budget`, title: clip(`${project.name} — budget ledger`, 160) },
        { documentId: `initiative:${project.id}:maintenance-30d`, title: clip(`${project.name} — maintenance, 30 days`, 160) }],
    }));
  }

  // 7. Sprint envelopes (budget tier only)
  if (grants && grants.length) {
    const rows = grants.map((g) =>
      `${g.granteeName ?? g.granteePersonId} — ${g.sprintName ?? 'no sprint'} · ${money(g.allocatedUsd)} granted · ${money(g.initiativeSpendInWindowUsd)} initiative spend in window`);
    slides.push(makePlan({
      slideId: 'envelopes', kind: 'initiative-envelopes', facts: { grants: grants.length, grantedUsd: money(sum(grants.map((g) => g.allocatedUsd))) },
      evidence: [], prose: 'none', maxProse: 0, factBullets: lines(rows, 'envelopes'), templateProse: [],
    }, {
      id: 'envelopes', layout: 'bullets', title: 'Sprint envelopes',
      sources: [{ documentId: `initiative:${project.id}:grants`, title: clip(`${project.name} — sprint envelopes`, 160) }],
    }));
  }

  // 8. Decisions
  if (decisions.length) {
    const rows = decisions.map((d) => `${d.topic} — ${statusLabel(d.status, 'no status')}${d.requiredRole ? ` · needs ${d.requiredRole}` : ''}`);
    const factBullets = lines(rows, 'decisions').slice(0, MAX_BULLETS_PER_SLIDE - 2);
    slides.push(makePlan({
      slideId: 'decisions', kind: 'initiative-decisions', facts: { decisions: decisions.length, open: openDecisions.length },
      evidence: evidenceOf(decisions.map((d) => ({ id: `decision:${d.id}`, text: d.summary }))).slice(0, 6),
      prose: 'bullets', maxProse: MAX_BULLETS_PER_SLIDE - factBullets.length, factBullets,
      templateProse: ['Decisions above are as recorded on the initiative.'],
    }, {
      id: 'decisions', layout: 'bullets', title: 'Decisions',
      sources: [initSrc, ...decisions.slice(0, MAX_SOURCES_PER_SLIDE - 1).map((d) => ({ documentId: `decision:${d.id}`, title: clip(`Decision ${d.topic}`, 160) }))],
    }));
  }

  const title = clip(options.title?.trim() || `${project.name} — status`, MAX_TITLE_CHARS);
  const subtitle = clip(`${statusLabel(project.status, 'Status not set')} · as of ${src.asOf}${brief?.window ? ` · focus: ${windowLabel(brief.window)}` : ''}`, 200);
  return { teamId: project.id, slides, spec: { title, subtitle, theme: 'plain', slides: slides.map((s) => s.base) } };
}

/**
 * The drafter's input for `initiative-status-deck`: `teamId` carries the
 * initiative id. A brief (G55) goes in as `brief: { words, window }`: the
 * requester's words quoted as data, with the sprint window they selected; the
 * prompt (agents/assessment-drafter/deck_narrative.py) lets it choose the period
 * and theme the prose covers and nothing else.
 */
export function buildInitiativeDraftInput(facts: DeckFacts, brief: DeckBrief | null = null): DraftDeckInput {
  return {
    teamId: facts.teamId,
    ...(brief ? { brief: { words: brief.words, window: brief.window } } : {}),
    slides: facts.slides.filter((s) => INITIATIVE_NARRATIVE_KINDS.has(s.kind)).map((s) => ({
      slideId: s.slideId, kind: s.kind, facts: s.facts, evidence: s.evidence,
    })),
  };
}
