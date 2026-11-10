// A work item's next step, derived from what it waits on (leftovers 2, 10
// November). One function for every reader: the Brief tab's callout
// (pages/project-detail/briefModel.ts), the voice's `get work-item`
// (lib/voice/tools.ts), the page context note's rows (the initiative page's
// publisher) and the composer's prompt builder (composerPrompts.ts).
//
// A decision the item waits on is live state, never seeded prose (second
// regression walk: after the cutover decision was resolved the runbook story
// still said "Sienna Garcia decides"; the judge-model and warm-floor stories
// said "… decides" with nothing checking whether anyone still had to). So the
// decision the item names (`blockedByDecisionId`, else the decision that names
// the item, an open one first) decides the line:
//
//   * still open or escalated: the decision comes first. The detail is the
//     block's reason (who and when) while blocked, else the row's own step as
//     what follows it;
//   * rejected: the item is replanned;
//   * decided, and no longer blocked (the settle keeps `blockedByDecisionId`
//     as the record): the brief's first unmet acceptance criterion, when the
//     criteria were read, else the row's own step.
//
// Without a linked decision the row's own step stands. No React; unit-tested.

export interface NextStepItem {
  id?: string | null;
  nextStep?: string | null;
  nextStepDetail?: string | null;
  labels?: readonly string[] | null;
  blockedReason?: string | null;
  blockedByDecisionId?: string | null;
}

export interface NextStepDecision {
  id: string;
  topic: string;
  status?: string | null;
  workItemId?: string | null;
}

export interface NextStepCriterion {
  text: string;
  done: boolean;
  position: number;
}

export interface NextStepContext {
  /** The initiative's decisions as read; null or absent while unread. */
  decisions?: readonly NextStepDecision[] | null;
  /** The item's acceptance criteria as read; null or absent while unread. */
  criteria?: readonly NextStepCriterion[] | null;
}

export interface DerivedNextStep {
  /** "The decision "Judge model for nightly evals" comes first." */
  step: string;
  /** The block's reason, what follows the decision, or that it is decided. */
  detail: string | null;
  /** Where the step came from: the decision it waits on, a criterion, or the row's own field. */
  from: 'decision' | 'criterion' | 'row';
}

export const OPEN_DECISION_STATUSES: ReadonlySet<string> = new Set(['open', 'escalated']);
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`);

/** The decision the item waits on, if any: the one it names, else an open one that names it, else any that names it. */
export function decisionWaitedOn(item: NextStepItem, decisions: readonly NextStepDecision[] | null | undefined): NextStepDecision | null {
  const all = decisions ?? [];
  const named = item.blockedByDecisionId ? all.find((d) => d.id === item.blockedByDecisionId) : undefined;
  const linked = item.id ? all.filter((d) => d.workItemId === item.id) : [];
  return named ?? linked.find((d) => OPEN_DECISION_STATUSES.has(String(d.status))) ?? linked[0] ?? null;
}

/** The item's next step; null when there is none (hidden, never faked). */
export function derivedNextStep(item: NextStepItem, context: NextStepContext = {}): DerivedNextStep | null {
  const ownStep = item.nextStep?.trim() || null;
  const own: DerivedNextStep | null = ownStep ? { step: ownStep, detail: item.nextStepDetail?.trim() || null, from: 'row' } : null;
  const waitsOn = decisionWaitedOn(item, context.decisions);
  if (!waitsOn) return own;
  const blocked = (item.labels?.includes('blocked') ?? false) || !!item.blockedReason?.trim();
  const reason = item.blockedReason?.trim() || null;
  const status = String(waitsOn.status ?? '');
  if (OPEN_DECISION_STATUSES.has(status)) {
    const step = `The ${status === 'escalated' ? 'escalated ' : ''}decision "${waitsOn.topic}" comes first.`;
    return { step, detail: blocked ? reason : ownStep ? `Then: ${sentence(ownStep)}` : null, from: 'decision' };
  }
  if (status === 'rejected') {
    return { step: `Replan this item: the decision "${waitsOn.topic}" was rejected.`, detail: reason, from: 'decision' };
  }
  if (status === 'resolved' && !blocked) {
    const next = [...(context.criteria ?? [])].sort((a, b) => a.position - b.position).find((c) => !c.done && c.text.trim());
    if (next) return { step: sentence(next.text.trim()), detail: `"${waitsOn.topic}" is decided.`, from: 'criterion' };
  }
  return own;
}
