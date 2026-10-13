// The local intents: each a pure function from rows the pages already read to
// prose plus the rows it used. No I/O, no clock reads, no model — the loader
// (./index.ts) reads the providers and passes the rows and `asOf` in, so a test
// can hand the same rows to an intent and to the Initiatives table and compare.
//
// Every number in an answer is computed here, from those rows, at request
// time. Money appears only when `viewer.canReadBudgets` (the budgets read tier,
// lib/budget-read-tier.ts); below it an answer says why it has no figures.

import type { ProjectSummary } from '../../providers/projects.js';
import type { WorkItem } from '../../providers/work-items.js';
import type { SprintRow } from '../../providers/sprints.js';
import type { Maintenance30d } from '../../providers/budgets.js';
import type { LocalIntent, IntentMatch } from './match.js';
import { usd, pct, sumUsd, monthLabel, monthName, plural, listing } from './format.js';

export interface LocalViewer { canReadBudgets: boolean; role: string }

/** A cited record, in the Answer tab's evidence shape (providers/search.ts SearchRecord). */
export interface LocalRecord {
  type: 'initiative' | 'work';
  id: string; title: string; href: string; n: number;
  status?: string; subtitle?: string; description?: string;
}
export interface LocalEdge { id: string; source: string; target: string; label: string }

export interface LocalAnswer {
  intent: LocalIntent;
  text: string;
  records: LocalRecord[];
  edges: LocalEdge[];
  /** The structured rows the prose was computed from — figures included only for the budget tier. */
  rows: Array<Record<string, unknown>>;
  /** Which rows were read, in words, for the STEP/tool-call trail. */
  sources: string[];
}

export type Contributor = { name: string; role: string | null };

export interface IntentInput {
  match: IntentMatch;
  viewer: LocalViewer;
  asOf: Date;
  /** Every initiative the caller can list (the Initiatives table's rows). */
  initiatives: ProjectSummary[];
  /** True when the list read hit its window, so "every initiative" is a floor. */
  initiativesCapped: boolean;
  /** The initiatives the question is about (scope or named); empty = the portfolio. */
  focus: ProjectSummary[];
  /** The work item the composer's scope named, when it named one. */
  focusItem?: WorkItem | null;
  maintenance?: Map<string, Maintenance30d>;
  workItems?: Map<string, WorkItem[]>;
  sprints?: SprintRow[];
  /** True when `sprints` is the caller's own (mine) view rather than the whole board. */
  sprintsMineOnly?: boolean;
  contributors?: Map<string, Contributor[]>;
}

// ─── Citations ───────────────────────────────────────────────────────────────

class Citations {
  readonly records: LocalRecord[] = [];
  readonly edges: LocalEdge[] = [];
  private readonly byKey = new Map<string, number>();
  initiative(p: ProjectSummary, description?: string): string {
    return this.add({ type: 'initiative', id: p.id, title: p.name, href: `/iq/projects/${encodeURIComponent(p.id)}`,
      ...(p.status ? { status: p.status } : {}), ...(p.ownerName ? { subtitle: `Owner: ${p.ownerName}` } : {}),
      ...(description ? { description } : {}) });
  }
  work(w: WorkItem, description?: string): string {
    const ref = this.add({ type: 'work', id: w.id, title: w.title,
      href: `/iq/projects/${encodeURIComponent(w.projectId)}?tab=work&item=${encodeURIComponent(w.id)}`,
      status: isBlocked(w) ? 'blocked' : w.status,
      subtitle: [w.key, w.projectName, w.assigneeName].filter(Boolean).join(' · '),
      ...(description ? { description } : {}) });
    const id = `initiative:${w.projectId}:includes:work:${w.id}`;
    if (this.byKey.has(`initiative:${w.projectId}`) && !this.edges.some(e => e.id === id)) {
      this.edges.push({ id, source: `initiative:${w.projectId}`, target: `work:${w.id}`, label: 'includes' });
    }
    return ref;
  }
  private add(r: Omit<LocalRecord, 'n'>): string {
    const key = `${r.type}:${r.id}`;
    let n = this.byKey.get(key);
    if (n == null) { n = this.records.length + 1; this.byKey.set(key, n); this.records.push({ ...r, n }); }
    return `[${n}]`;
  }
}

// ─── Shared rules ────────────────────────────────────────────────────────────

const OPEN = new Set(['open', 'in_progress', 'in_review']);
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
/** Same predicate the Search records use (providers/search.ts): a reason or a `blocked` label. */
export const isBlocked = (w: WorkItem): boolean => Boolean(w.blockedReason) || (w.labels ?? []).includes('blocked');
export const isOpen = (w: WorkItem): boolean => OPEN.has(w.status) && w.type !== 'epic';
/** The share of an allocation spent, or null when there is no positive allocation to be over. */
export const burn = (p: ProjectSummary): number | null =>
  p.allocatedUsd != null && p.allocatedUsd > 0 ? (p.agentSpendUsd ?? 0) / p.allocatedUsd : null;
/** At or past this share of the allocation an initiative is "near" it. */
export const NEAR_SHARE = 0.8;
/** A sprint is behind when its share of points done trails its share of days elapsed by more than this. */
export const BEHIND_SLACK = 0.25;

const DAY_MS = 86_400_000;
/** Share of a sprint's days elapsed at `asOf` (inclusive end date), clamped to [0, 1]. */
export function sprintElapsed(s: Pick<SprintRow, 'startsOn' | 'endsOn'>, asOf: Date): number | null {
  if (!s.startsOn || !s.endsOn) return null;
  const start = Date.parse(`${s.startsOn.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${s.endsOn.slice(0, 10)}T00:00:00Z`) + DAY_MS;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return Math.min(1, Math.max(0, (asOf.getTime() - start) / (end - start)));
}
export function sprintBehind(s: SprintRow, asOf: Date): boolean {
  if (s.status !== 'active' || s.pointsTotal <= 0) return false;
  const elapsed = sprintElapsed(s, asOf);
  return elapsed != null && s.pointsDone / s.pointsTotal < elapsed - BEHIND_SLACK;
}

const noFigures = (viewer: LocalViewer): string =>
  `I can't show budget figures to your role. Spend, allocations and maintenance floors are visible to the budgets read tier — org-leader, hr-admin and program-owner, or anyone holding ManageBudgets — and you are signed in as ${viewer.role}. ` +
  'You can still ask which initiatives are blocked, critical or behind, who owns an initiative, or what is open on it.';

const capNote = (input: IntentInput): string =>
  input.initiativesCapped ? ` (read from the first ${input.initiatives.length} initiatives; more exist)` : '';

// ─── budget: over / near / unbudgeted, and the maintenance floor ─────────────

export function budgetAnswer(input: IntentInput): LocalAnswer {
  const { viewer, asOf } = input;
  const c = new Citations();
  const sources = ['initiatives (spend month-to-date, allocation)', 'maintenance floor (cron runs, last 30 days)'];
  if (!viewer.canReadBudgets) {
    input.focus.forEach(p => c.initiative(p));
    return { intent: 'budget', text: noFigures(viewer), records: c.records, edges: [], rows: [], sources: [] };
  }
  const month = monthName(asOf);
  const set = input.focus.length ? input.focus : input.initiatives;
  const floor = (p: ProjectSummary) => input.maintenance?.get(p.id) ?? null;
  const rows = set.map(p => ({
    initiativeId: p.id, name: p.name,
    spendMtdUsd: p.agentSpendUsd ?? 0, allocatedUsd: p.allocatedUsd,
    share: burn(p), maintenance30dUsd: floor(p)?.costUsd ?? null, cronRuns30d: floor(p)?.cronRuns ?? null,
  }));
  const figure = (p: ProjectSummary) => p.allocatedUsd != null
    ? `${usd(p.agentSpendUsd ?? 0)} of ${usd(p.allocatedUsd)}${burn(p) != null ? ` (${pct(burn(p)!)})` : ''}`
    : `${usd(p.agentSpendUsd ?? 0)} with no allocation`;
  const cite = (p: ProjectSummary) => `${p.name} ${c.initiative(p, `Spend ${figure(p)} in ${monthLabel(asOf)}`)}`;
  const lines: string[] = [];

  if (input.focus.length) {
    for (const p of set) {
      const share = burn(p);
      const spend = p.agentSpendUsd ?? 0;
      if (p.allocatedUsd == null) {
        lines.push(`${cite(p)} has no ${month} allocation${spend > 0 ? `, and ${usd(spend)} of agent spend this month — spend nobody has budgeted` : ' and no agent spend this month'}.`);
      } else if (spend > p.allocatedUsd) {
        lines.push(`${cite(p)} is over its ${month} allocation: ${figure(p)}, ${usd(spend - p.allocatedUsd)} over.`);
      } else {
        lines.push(`${cite(p)} is ${share != null && share >= NEAR_SHARE ? 'near' : 'within'} its ${month} allocation: ${figure(p)}, ${usd(p.allocatedUsd - spend)} left.`);
      }
      const f = floor(p);
      if (f && p.allocatedUsd != null && p.allocatedUsd > 0) {
        lines.push(`Its maintenance floor — cron runs over the last 30 days — is ${usd(f.costUsd)} (${plural(f.cronRuns, 'run')}), ${pct(f.costUsd / p.allocatedUsd)} of the allocation${f.costUsd >= NEAR_SHARE * p.allocatedUsd ? ', which leaves little room for new work' : ''}.`);
      } else if (f) {
        lines.push(`Its maintenance floor over the last 30 days is ${usd(f.costUsd)} (${plural(f.cronRuns, 'cron run')}).`);
      }
    }
  } else {
    const over = set.filter(p => (p.agentSpendUsd ?? 0) > 0 && p.allocatedUsd != null && (p.agentSpendUsd ?? 0) > p.allocatedUsd)
      .sort((a, b) => (burn(b) ?? Infinity) - (burn(a) ?? Infinity));
    const near = set.filter(p => !over.includes(p) && (burn(p) ?? 0) >= NEAR_SHARE).sort((a, b) => burn(b)! - burn(a)!);
    const unbudgeted = set.filter(p => p.allocatedUsd == null && (p.agentSpendUsd ?? 0) > 0)
      .sort((a, b) => (b.agentSpendUsd ?? 0) - (a.agentSpendUsd ?? 0));
    if (over.length) {
      lines.push(`${plural(over.length, 'initiative is', 'initiatives are')} over ${over.length === 1 ? 'its' : 'their'} ${month} allocation: ${listing(over.map(p => `${cite(p)} at ${figure(p)}`))}.`);
    } else {
      const closest = set.filter(p => burn(p) != null).sort((a, b) => burn(b)! - burn(a)!)[0];
      lines.push(`No initiative is over its ${month} allocation${capNote(input)}${closest ? `; the closest is ${cite(closest)} at ${figure(closest)}` : ''}.`);
    }
    if (near.length) lines.push(`Near the allocation (${pct(NEAR_SHARE)} or more spent): ${listing(near.map(p => `${cite(p)} at ${figure(p)}`))}.`);
    if (unbudgeted.length) {
      lines.push(unbudgeted.length === 1
        ? `${cite(unbudgeted[0]!)} has ${usd(unbudgeted[0]!.agentSpendUsd ?? 0)} spend and no allocation.`
        : `Spending with no allocation: ${listing(unbudgeted.map(p => `${cite(p)} (${usd(p.agentSpendUsd ?? 0)})`))}.`);
    }
    if (input.maintenance) {
      const tight = set.filter(p => p.allocatedUsd != null && p.allocatedUsd > 0 && (floor(p)?.costUsd ?? 0) >= NEAR_SHARE * p.allocatedUsd);
      const topFloor = set.filter(p => p.allocatedUsd != null && p.allocatedUsd > 0 && floor(p))
        .sort((a, b) => floor(b)!.costUsd / b.allocatedUsd! - floor(a)!.costUsd / a.allocatedUsd!)[0];
      if (tight.length) {
        lines.push(`Maintenance floor near the allocation — little room for new work: ${listing(tight.map(p => `${cite(p)} (${usd(floor(p)!.costUsd)} of cron runs in 30 days against ${usd(p.allocatedUsd!)})`))}.`);
      } else if (topFloor) {
        lines.push(`No maintenance floor is near its allocation; the highest is ${cite(topFloor)} at ${usd(floor(topFloor)!.costUsd)} of cron runs over 30 days (${pct(floor(topFloor)!.costUsd / topFloor.allocatedUsd!)} of ${usd(topFloor.allocatedUsd!)}).`);
      }
    }
  }
  lines.push(`_Spend is month-to-date for ${monthLabel(asOf)}, the same window as the Initiatives table and the Budgets ledger; the maintenance floor is the last 30 days of cron-triggered runs._`);
  return { intent: 'budget', text: lines.join('\n\n'), records: c.records, edges: [], rows, sources };
}

// ─── spend: how much did X spend this month ──────────────────────────────────

export function spendAnswer(input: IntentInput): LocalAnswer {
  const { viewer, asOf } = input;
  const c = new Citations();
  if (!viewer.canReadBudgets) {
    input.focus.forEach(p => c.initiative(p));
    return { intent: 'spend', text: noFigures(viewer), records: c.records, edges: [], rows: [], sources: [] };
  }
  const set = input.focus.length ? input.focus : input.initiatives;
  const rows = set.map(p => ({ initiativeId: p.id, name: p.name, spendMtdUsd: p.agentSpendUsd ?? 0, allocatedUsd: p.allocatedUsd }));
  const month = monthLabel(asOf);
  const lines: string[] = [];
  const of = (p: ProjectSummary) => p.allocatedUsd != null ? ` of a ${usd(p.allocatedUsd)} allocation` : ', with no allocation';
  if (input.focus.length) {
    for (const p of set) lines.push(`${p.name} ${c.initiative(p)} has spent ${usd(p.agentSpendUsd ?? 0)} on agents so far in ${month}${of(p)}.`);
  } else {
    const total = sumUsd(set.map(p => p.agentSpendUsd ?? 0));
    const spending = set.filter(p => (p.agentSpendUsd ?? 0) > 0).sort((a, b) => (b.agentSpendUsd ?? 0) - (a.agentSpendUsd ?? 0));
    lines.push(`Agent spend so far in ${month} is ${usd(total)} across ${plural(spending.length, 'initiative')}${capNote(input)}.`);
    if (spending.length) lines.push(`The most: ${listing(spending.slice(0, 3).map(p => `${p.name} ${c.initiative(p)} ${usd(p.agentSpendUsd ?? 0)}${of(p)}`))}.`);
  }
  lines.push('_Month-to-date, the same window as the Initiatives table and the Budgets ledger._');
  return { intent: 'spend', text: lines.join('\n\n'), records: c.records, edges: [], rows, sources: ['initiatives (spend month-to-date, allocation)'] };
}

// ─── status: which initiatives are blocked / critical / behind ───────────────

export function statusAnswer(input: IntentInput): LocalAnswer {
  const { match, asOf } = input;
  const c = new Citations();
  const set = input.focus.length ? input.focus : input.initiatives;
  const asked = match.facets.blocked || match.facets.critical || match.facets.behind
    ? match.facets : { blocked: true, critical: true, behind: true };
  const lines: string[] = [];
  const rows: Array<Record<string, unknown>> = [];
  const sources: string[] = [];

  if (asked.critical) {
    sources.push('initiatives (highest open work priority)');
    const critical = set.filter(p => p.priority === 'critical');
    critical.forEach(p => rows.push({ facet: 'critical', initiativeId: p.id, name: p.name, priority: p.priority }));
    lines.push(critical.length
      ? `**Critical** — ${plural(critical.length, 'initiative has', 'initiatives have')} open critical work: ${listing(critical.map(p => `${p.name} ${c.initiative(p)}`))}.`
      : `**Critical** — no initiative has open critical work${capNote(input)}.`);
  }
  if (asked.blocked) {
    sources.push('work items (open, with a blocked reason or label)');
    const blocked = set.map(p => ({ p, items: (input.workItems?.get(p.id) ?? []).filter(w => isOpen(w) && isBlocked(w)) }))
      .filter(x => x.items.length > 0).sort((a, b) => b.items.length - a.items.length);
    blocked.forEach(x => rows.push({ facet: 'blocked', initiativeId: x.p.id, name: x.p.name, blockedItems: x.items.map(w => w.key ?? w.id) }));
    lines.push(blocked.length
      ? `**Blocked** — ${plural(blocked.length, 'initiative has', 'initiatives have')} blocked work:\n${blocked.map(x =>
        `- ${x.p.name} ${c.initiative(x.p)}: ${listing(x.items.slice(0, 3).map(w => `${w.key ? `${w.key} ` : ''}${w.title} ${c.work(w)}${w.blockedReason ? ` (${w.blockedReason.replace(/\.$/, '')})` : ''}`))}${x.items.length > 3 ? ` and ${x.items.length - 3} more` : ''}`).join('\n')}`
      : '**Blocked** — no open work item is blocked.');
  }
  if (asked.behind) {
    sources.push(input.sprintsMineOnly ? 'your sprints' : 'sprints (points done vs days elapsed)');
    const ids = new Set(set.map(p => p.id));
    const behind = (input.sprints ?? []).filter(s => ids.has(s.orgProjectId) && sprintBehind(s, asOf));
    const byId = new Map(set.map(p => [p.id, p]));
    behind.forEach(s => rows.push({ facet: 'behind', initiativeId: s.orgProjectId, sprintId: s.id, sprint: s.name, pointsDone: s.pointsDone, pointsTotal: s.pointsTotal, elapsedShare: sprintElapsed(s, asOf) }));
    const scopeNote = input.sprintsMineOnly ? ' among the sprints you steward, hold a grant on or have work in (the whole board is the budgets read tier\'s)' : '';
    lines.push(behind.length
      ? `**Behind** — ${plural(behind.length, 'active sprint is', 'active sprints are')} behind${scopeNote}:\n${behind.map(s => {
        const p = byId.get(s.orgProjectId)!;
        return `- ${p.name} ${c.initiative(p)}, ${s.name}: ${s.pointsDone} of ${s.pointsTotal} points done with ${pct(sprintElapsed(s, asOf) ?? 0)} of the sprint elapsed (ends ${s.endsOn?.slice(0, 10)})`;
      }).join('\n')}`
      : `**Behind** — no active sprint is behind${scopeNote}.`);
    lines.push(`_An active sprint is behind when its share of points done trails its share of days elapsed by more than ${pct(BEHIND_SLACK)}._`);
  }
  return { intent: 'status', text: lines.join('\n\n'), records: c.records, edges: c.edges, rows, sources };
}

// ─── owners: who owns / who is on X ──────────────────────────────────────────

export function ownersAnswer(input: IntentInput): LocalAnswer {
  const c = new Citations();
  const set = input.focus.length ? input.focus : input.initiatives;
  const rows: Array<Record<string, unknown>> = [];
  const lines = set.map(p => {
    const people = input.contributors?.get(p.id) ?? [];
    const others = people.filter(x => x.name !== p.ownerName);
    rows.push({ initiativeId: p.id, name: p.name, owner: p.ownerName, smes: p.smeNames, contributors: people });
    const owner = p.ownerName ? `owned by ${p.ownerName}` : 'has no owner set';
    if (!input.focus.length) return `- ${p.name} ${c.initiative(p)}: ${owner}${p.smeNames.length ? `; SMEs ${listing(p.smeNames)}` : ''}`;
    const roleOf = (r: string) => r.toLowerCase() === 'sme' ? 'SME' : r;
    const team = others.length ? ` On it: ${listing(others.map(x => `${x.name}${x.role ? ` (${roleOf(x.role)})` : ''}`))}.` : p.smeNames.length ? ` SMEs: ${listing(p.smeNames)}.` : ' Nobody else is attached.';
    return `${p.name} ${c.initiative(p)} is ${owner}.${team}`;
  });
  const text = input.focus.length ? lines.join('\n\n') : `Owners of ${plural(set.length, 'initiative')}${capNote(input)}:\n${lines.join('\n')}`;
  return { intent: 'owners', text, records: c.records, edges: [], rows, sources: ['initiatives (owner, SMEs)', ...(input.focus.length ? ['initiative contributors'] : [])] };
}

// ─── work: what is open / critical / blocked on X ────────────────────────────

export function workAnswer(input: IntentInput): LocalAnswer {
  const { match } = input;
  const c = new Citations();
  const rows: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  for (const p of input.focus) {
    const ref = c.initiative(p);
    const open = (input.workItems?.get(p.id) ?? []).filter(isOpen)
      .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4) || Number(isBlocked(b)) - Number(isBlocked(a)));
    let shown = open;
    let what = 'open';
    if (match.facets.blocked) { shown = open.filter(isBlocked); what = 'blocked'; }
    else if (match.facets.critical) { shown = open.filter(w => w.priority === 'critical'); what = 'open critical'; }
    if (input.focusItem && input.focusItem.projectId === p.id) {
      const w = input.focusItem;
      lines.push(`${w.key ?? w.title} ${c.work(w)} is ${w.status.replace(/_/g, ' ')}, ${w.priority}${w.assigneeName ? `, with ${w.assigneeName}` : ', unassigned'}${isBlocked(w) ? ` — blocked${w.blockedReason ? `: ${w.blockedReason}` : ''}` : ''}.`);
    }
    shown.forEach(w => rows.push({ initiativeId: p.id, workItemId: w.id, key: w.key ?? null, title: w.title, status: w.status, priority: w.priority, blocked: isBlocked(w), assignee: w.assigneeName }));
    if (!shown.length) { lines.push(`${p.name} ${ref} has no ${what} work items (${plural(open.length, 'open item')} in all).`); continue; }
    lines.push(`${p.name} ${ref} has ${plural(shown.length, `${what} work item`)}${what !== 'open' ? ` of ${open.length} open` : ''}:\n${shown.slice(0, 8).map(w =>
      `- ${w.key ? `${w.key} ` : ''}${w.title} ${c.work(w)} — ${w.status.replace(/_/g, ' ')}, ${w.priority}${w.assigneeName ? `, ${w.assigneeName}` : ''}${isBlocked(w) ? `, blocked${w.blockedReason ? `: ${w.blockedReason.replace(/\.$/, '')}` : ''}` : ''}`).join('\n')}${shown.length > 8 ? `\n- …and ${shown.length - 8} more on the initiative's Work tab` : ''}`);
  }
  return { intent: 'work', text: lines.join('\n\n'), records: c.records, edges: c.edges, rows, sources: ['work items'] };
}

// ─── sprints: status of the active sprints ───────────────────────────────────

export function sprintsAnswer(input: IntentInput): LocalAnswer {
  const { viewer, asOf } = input;
  const c = new Citations();
  const ids = input.focus.length ? new Set(input.focus.map(p => p.id)) : null;
  const byId = new Map(input.initiatives.map(p => [p.id, p]));
  const visible = (input.sprints ?? []).filter(s => !ids || ids.has(s.orgProjectId));
  // "Which sprints are behind?" lists only those; anything else lists every active sprint.
  const active = visible.filter(s => s.status === 'active' && (!input.match.facets.behind || sprintBehind(s, asOf)));
  const rows = active.map(s => ({
    sprintId: s.id, initiativeId: s.orgProjectId, name: s.name, endsOn: s.endsOn, pointsDone: s.pointsDone, pointsTotal: s.pointsTotal,
    itemsDone: s.doneItemCount, items: s.itemCount, behind: sprintBehind(s, asOf),
    ...(viewer.canReadBudgets ? { grantedUsd: s.grantedUsd, initiativeSpendInWindowUsd: s.initiativeSpendInWindowUsd } : {}),
  }));
  const whose = input.sprintsMineOnly ? 'you steward, hold a grant on or have work in' : '';
  const lines: string[] = [];
  if (!active.length) {
    lines.push(`No active sprint${whose ? ` ${whose}` : ''}${ids ? ` on ${listing(input.focus.map(p => `${p.name} ${c.initiative(p)}`))}` : ''}${input.match.facets.behind ? ' is behind' : ''}.`);
  } else {
    const behindCount = rows.filter(r => r.behind).length;
    lines.push(input.match.facets.behind
      ? `${plural(active.length, 'active sprint is', 'active sprints are')} behind${whose ? ` (of those ${whose})` : ''}:`
      : `${plural(active.length, 'active sprint')}${whose ? ` ${whose}` : ''}${behindCount ? `, ${behindCount} behind` : ', none behind'}:`);
    lines.push(active.slice(0, 12).map(s => {
      const p = byId.get(s.orgProjectId);
      const money = viewer.canReadBudgets && s.grantedUsd > 0 ? `; envelope ${usd(s.grantedUsd)}, initiative spend in the window ${usd(s.initiativeSpendInWindowUsd)}` : '';
      return `- ${p ? `${p.name} ${c.initiative(p)}` : s.orgProjectName ?? s.orgProjectId}, ${s.name}: ${s.pointsDone} of ${s.pointsTotal} points, ${s.doneItemCount} of ${s.itemCount} items done; ends ${s.endsOn?.slice(0, 10) ?? 'undated'}${sprintBehind(s, asOf) ? ' — behind' : ''}${money}`;
    }).join('\n') + (active.length > 12 ? `\n- …and ${active.length - 12} more on the Sprints page` : ''));
  }
  if (input.match.facets.behind || active.some(s => sprintBehind(s, asOf))) lines.push(`_An active sprint is behind when its share of points done trails its share of days elapsed by more than ${pct(BEHIND_SLACK)}._`);
  if (input.sprintsMineOnly) lines.push('_The whole sprint board, with envelopes, is visible to the budgets read tier; this is your own view._');
  return { intent: 'sprints', text: lines.join('\n\n'), records: c.records, edges: [], rows,
    sources: [input.sprintsMineOnly ? 'your sprints' : 'sprints'] };
}

export const INTENTS: Record<LocalIntent, (input: IntentInput) => LocalAnswer> = {
  budget: budgetAnswer, spend: spendAnswer, status: statusAnswer, owners: ownersAnswer, work: workAnswer, sprints: sprintsAnswer,
};
