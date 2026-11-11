// Bell items for runbook proposals, so a proposal never waits unseen (value sweep package 2).
//
//   filed      the people who may decide it, resolved inside the orgiq tenant by the same rule the
//              accept and reject routes use (lib/runbook-review.ts), never the author;
//   decided    the person who filed it, or the person who dispatched the run that did, never the
//              person who just decided;
//   expiring   one notice to the reviewers three days before a run's proposal would be withdrawn.
//
// Every function here is best effort and never throws: a failed notice must not fail the filing,
// the decision or the sweep. Recipients are always read from the orgiq tenant, and notify()
// itself drops anyone without an orgiq grant. The proposal route re-checks scope on every decision.
import type { RunbookStore } from './store.js';
import type { Runbook, RunbookProposal, RunbookScope } from './types.js';
import { personOnInitiative } from '../initiative-scope.js';
import { eligibleReviewerIds, mayReviewRunbook } from '../runbook-review.js';
import type { Session } from '../session.js';

const DAY_MS = 86_400_000;
/** Mirrors retire.ts (which calls this module, so it cannot import it back). */
const PROPOSAL_EXPIRY_DAYS = 14;
/** The reviewers hear about an expiring proposal this many days before it is withdrawn. */
export const EXPIRY_NOTICE_DAYS = 3;

/** The portal page that reviews one proposal. */
export const proposalReviewHref = (id: string): string => `/iq/runbooks/proposals/${encodeURIComponent(id)}`;

/**
 * R8: the initiative a proposal came from, the "area" whose SMEs steward a cross-project skill.
 * The proposer must not be able to pick it (that would pick their reviewer):
 *   - a run proposal's work item came from the run's frozen brief (the POST ignores the body's), so it stands;
 *   - a person's work item counts only on an initiative the proposer owns or contributes to
 *     (lib/initiative-scope.ts, the one "mine" rule); otherwise the proposal has no area and
 *     only an org-leader (or admin) decides it.
 */
export async function proposalArea(p: RunbookProposal): Promise<string | null> {
  if (!p.source.work_item_id) return null;
  let initiative: string | null = null;
  try {
    const { getWorkItem } = await import('../../providers/work-items.js');
    initiative = (await getWorkItem(p.source.work_item_id))?.projectId ?? null;
  } catch { return null; }
  if (!initiative) return null;
  if (p.source.kind === 'run') return initiative;
  return (await personOnInitiative(p.source.person_id, initiative)) ? initiative : null;
}

export async function newProposalScope(p: RunbookProposal): Promise<RunbookScope> {
  if (p.proposed_files?.length) return { kind: 'org', ref: null };
  const area = await proposalArea(p);
  return area ? { kind: 'initiative', ref: area } : { kind: 'org', ref: null };
}

/** The scope, owner and area the review rule judges a proposal against; null when its runbook is gone. */
export async function reviewScopeOf(s: RunbookStore, p: RunbookProposal): Promise<{ scope: RunbookScope; owner: string | null; area: string | null } | null> {
  if (p.kind === 'new') {
    // A new proposal that already carries a scope (a run's) is judged against it, like the accept route does.
    const area = await proposalArea(p);
    let scope = p.proposed_scope ?? await newProposalScope(p);
    // A person's requested initiative is not their area unless the work item proves it: the accept
    // route refuses a steward there, so the stewards of a merely requested initiative are not reviewers.
    if (p.source.kind === 'person' && scope.kind === 'initiative' && scope.ref !== area) scope = { kind: 'org', ref: null };
    return { scope, owner: null, area };
  }
  const target: Runbook | null = p.runbook_id ? await s.getRunbook(p.runbook_id) : null;
  return target ? { scope: target.scope, owner: target.owner_person_id, area: target.area ?? null } : null;
}

/** The account an author or dispatcher id (a person id or a subject) belongs to. */
async function accountOf(id: string): Promise<string> {
  try {
    const { userForPerson } = await import('../social-notify.js');
    return (await userForPerson(id)) ?? id;
  } catch { return id; }
}

function nameOf(p: RunbookProposal): string {
  return p.proposed?.title ?? p.runbook_id ?? 'a new runbook';
}

function authorIds(p: RunbookProposal): string[] {
  return [p.source.person_id, p.source.kind === 'run' ? p.source.dispatched_by : undefined]
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/** Who may decide `p`, never its author. A run's dispatcher counts only when nobody else could (decision 11). */
export async function proposalReviewers(s: RunbookStore, p: RunbookProposal, extraExclude: ReadonlyArray<string | null | undefined> = []): Promise<string[]> {
  const rs = await reviewScopeOf(s, p);
  if (!rs) return [];
  const exclude = [...authorIds(p), ...extraExclude];
  const others = await eligibleReviewerIds(rs.scope, rs.owner, rs.area, exclude);
  if (others.length > 0) return others;
  const dispatcher = p.source.kind === 'run' ? p.source.dispatched_by : undefined;
  if (!dispatcher) return [];
  // Nobody else could decide it: the dispatcher may, if they hold review rights themselves.
  const user = await accountOf(dispatcher);
  return (await eligibleReviewerIds(rs.scope, rs.owner, rs.area, extraExclude)).filter((id) => id === user || id === dispatcher);
}

async function send(recipients: string[], input: Parameters<typeof import('../social-notify.js').notify>[1]): Promise<string[]> {
  if (recipients.length === 0) return [];
  const { notify } = await import('../social-notify.js');
  return notify([...new Set(recipients)], input);
}

/** A proposal was filed: tell the people who may review it. Never throws. */
export async function notifyFiled(s: RunbookStore, p: RunbookProposal): Promise<string[]> {
  try {
    const reviewers = await proposalReviewers(s, p);
    return await send(reviewers, {
      id: `runbook-proposal:${p.id}:filed`, type: 'approval-requested',
      title: p.kind === 'retire' ? `A runbook is proposed for retirement: ${nameOf(p)}`
        : p.kind === 'edit' ? `A change to ${nameOf(p)} is waiting for review` : `A new runbook is waiting for review: ${nameOf(p)}`,
      body: p.rationale,
      payload: { tenant: 'orgiq', kind: 'runbook-proposal', event: 'filed', proposalId: p.id, proposalKind: p.kind, ...(p.runbook_id ? { runbookId: p.runbook_id } : {}) },
      action: { label: 'Review the proposal', href: proposalReviewHref(p.id) },
    });
  } catch (err) {
    console.warn(`[runbook-notices] filing notice for ${p.id} failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * A proposal was accepted or rejected: tell its author, or the dispatcher of the run that wrote it.
 * `decidedBy` are the ids the decider acts under; they are never told about their own decision.
 */
export async function notifyDecided(p: RunbookProposal, decision: 'accepted' | 'rejected', decidedBy: ReadonlyArray<string | null | undefined>): Promise<string[]> {
  try {
    const who = p.source.kind === 'person' ? p.source.person_id : p.source.kind === 'run' ? p.source.dispatched_by : undefined;
    if (!who) return [];
    const skip = new Set(decidedBy.filter((x): x is string => typeof x === 'string' && x.length > 0));
    const user = await accountOf(who);
    if (skip.has(who) || skip.has(user)) return [];
    const accepted = decision === 'accepted';
    const note = p.note ? ` ${p.note}` : '';
    return await send([user], {
      id: `runbook-proposal:${p.id}:${decision}`, type: 'system',
      title: accepted ? `Your proposal for ${nameOf(p)} was accepted` : `Your proposal for ${nameOf(p)} was rejected`,
      body: `${accepted ? 'It is now in the library.' : 'It was not taken into the library.'}${note}`.trim(),
      payload: { tenant: 'orgiq', kind: 'runbook-proposal', event: decision, proposalId: p.id, proposalKind: p.kind, ...(p.runbook_id ? { runbookId: p.runbook_id } : {}) },
      action: { label: 'Open the proposal', href: proposalReviewHref(p.id) },
    });
  } catch (err) {
    console.warn(`[runbook-notices] decision notice for ${p.id} failed: ${(err as Error).message}`);
    return [];
  }
}

/**
 * Three days before a run's proposal expires, tell its reviewers once. The proposal itself carries
 * the mark (`expiry_notice_at`), written before the notice goes out, so a second sweep sends nothing.
 * Returns the ids it announced. Never throws.
 */
export async function notifyExpiring(s: RunbookStore, proposals: readonly RunbookProposal[], at: string): Promise<string[]> {
  const out: string[] = [];
  const nowMs = Date.parse(at);
  const from = (PROPOSAL_EXPIRY_DAYS - EXPIRY_NOTICE_DAYS) * DAY_MS;
  const until = PROPOSAL_EXPIRY_DAYS * DAY_MS;
  for (const p of proposals) {
    try {
      const age = nowMs - Date.parse(p.created_at);
      if (p.status !== 'open' || p.source.kind !== 'run' || p.expiry_notice_at || age < from || age > until) continue;
      await s.putProposal({ ...p, expiry_notice_at: at });
      const days = Math.max(1, Math.ceil((until - age) / DAY_MS));
      await send(await proposalReviewers(s, p), {
        id: `runbook-proposal:${p.id}:expiring`, type: 'system',
        title: `A proposal for ${nameOf(p)} expires in ${days} ${days === 1 ? 'day' : 'days'}`,
        body: `Nobody has decided it yet. After ${PROPOSAL_EXPIRY_DAYS} days it is withdrawn.`,
        payload: { tenant: 'orgiq', kind: 'runbook-proposal', event: 'expiring', proposalId: p.id, proposalKind: p.kind, ...(p.runbook_id ? { runbookId: p.runbook_id } : {}) },
        action: { label: 'Review the proposal', href: proposalReviewHref(p.id) },
      });
      out.push(p.id);
    } catch (err) {
      console.warn(`[runbook-notices] expiry notice for ${p.id} failed: ${(err as Error).message}`);
    }
  }
  return out;
}

/** How many open proposals `session` may decide now: the rail's count. Never counts their own or an expired one. */
export async function reviewableOpenCount(s: RunbookStore, session: Session, actor: string, personId: string | null, nowMs: number): Promise<number> {
  let n = 0;
  let cursor: string | undefined;
  do {
    const page = await s.listProposals({ status: ['open'], limit: 200, ...(cursor ? { cursor } : {}) });
    for (const p of page.items) {
      if (p.source.kind === 'run' && nowMs - Date.parse(p.created_at) > PROPOSAL_EXPIRY_DAYS * DAY_MS) continue;
      const mine = new Set([actor, personId, session.sub]);
      if (authorIds(p).some((id) => mine.has(id))) continue;
      try {
        const rs = await reviewScopeOf(s, p);
        if (rs && (await mayReviewRunbook(session, rs.scope, rs.owner, rs.area)).ok) n += 1;
      } catch { /* a proposal that cannot be judged is not counted */ }
    }
    cursor = page.next ?? undefined;
  } while (cursor);
  return n;
}
