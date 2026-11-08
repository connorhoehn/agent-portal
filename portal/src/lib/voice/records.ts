// The voice navigator's record actions (catalogue v2, docs/voice-tool-inventory.md
// §3): `decide` (V2-10), and `create` and `update` (V2-11). Each is a page
// button said out loud: the route that button calls, the body it sends, the
// Cedar action it is gated on, behind the dock's Confirm card.
//
// decide's rules:
// - the model names a row by the ref a read of this session handed out
//   (`approval:r-9`, `change:cr-1`) or its position in the last result, never
//   a name or a path; the planner then reads that row again through the read
//   its page lists it from, so a decision only ever reaches a row the
//   persona's own read returns, and the card shows what it is (the requester
//   and the item, the transaction's amount, the change's title);
// - can() holds the button's action for the decision before any request
//   (catalogue DECIDE_ACTIONS), and again at confirm when the card's toggle
//   flipped the decision; the route checks it again (the amount, the author);
// - the card carries `fields` (the library's approve / reject toggle and
//   note) where the row has both; a click answers { decision, note } and the
//   runner sends that; a voice "yes" sends the arguments;
// - a refusal from the route is said as the route said it (the change's
//   author is told someone else must decide it), and names no row the
//   persona could not read; a second decision on a decided row is the
//   route's own 409 / 404, said as "already decided", and the dock's ledger
//   never sends the same decision twice.
//
// No React and only `.ts` imports, so `node --test` runs it.

import { DECIDE_ACTIONS } from './catalogue.ts';
import { parseRef, type Rec } from './kinds.ts';
import {
  done, failed, once, qs, readFailure, readJson, refused,
  type CardAnswer, type ConfirmPlan, type ToolContext, type ToolResult, type VoiceToolArgs, type VoiceToolPlanner, type VoiceToolRunner,
} from './tools.ts';

const enc = encodeURIComponent;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const dig = (r: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Rec)[k] : undefined), r);
const usd = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : null);

type Verb = 'approve' | 'reject' | 'deliver';

/** The spoken decision as the card's verb: accept is approve, discard is reject. */
function verbOf(decision: string): Verb {
  return decision === 'deliver' ? 'deliver' : decision === 'reject' || decision === 'discard' ? 'reject' : 'approve';
}

/** One decision's request: the page button's route and body, with what the card says it does. */
interface Send { method: 'POST' | 'PATCH'; url: string; body: Record<string, unknown> }

/** What the planner fixed from the row the persona's own read returned. */
interface DecidePlan {
  kind: string;
  id: string;
  title: string;
  /** The verbs this row offers, each a fixed request; `note` is filled in at send time. */
  sends: Partial<Record<Verb, { send: (note: string | undefined) => Send; needsNote?: string; said: string }>>;
  verb: Verb;
  note?: string;
  href: string;
}

/** A row's decision options, read again through its page's own read. */
interface Resolved {
  title: string;
  detail: string[];
  href: string;
  sends: DecidePlan['sends'];
}

type Resolver = (id: string, ctx: ToolContext) => Promise<Resolved | { result: ToolResult }>;

const notWaiting = (what: string) => ({ result: refused(`That ${what} is not waiting on your decision, or you cannot read it.`) });

/** Access: the requests waiting on the caller (GET /api/access/approvals); the current step is the one decided. */
const accessRequest: Resolver = async (id, ctx) => {
  const read = await readJson<{ items?: Rec[] }>(ctx, '/api/access/approvals');
  if (!read.ok) return { result: readFailure('the requests waiting on you', read.status) };
  const row = (read.body.items ?? []).find((r) => r['id'] === id);
  if (!row) return notWaiting('request');
  const steps = Array.isArray(row['steps']) ? row['steps'] as Rec[] : [];
  const step = steps.find((s) => s['status'] === 'current')?.['step'];
  if (typeof step !== 'number') return notWaiting('request');
  const item = str(dig(row, 'item.title')) ?? 'an item';
  const who = str(dig(row, 'beneficiary.displayName')) ?? str(dig(row, 'requester.displayName')) ?? 'someone';
  const amount = usd(row['requestedUsd']);
  const url = `/api/access/requests/${enc(id)}/steps/${step}/decide`;
  return {
    title: `${item} for ${who}`,
    detail: [`Step ${step}${str(steps.find((s) => s['step'] === step)?.['kind']) ? ` (${String(steps.find((s) => s['step'] === step)!['kind'])})` : ''}.`, ...(amount ? [`Requests ${amount}.`] : [])],
    href: `/access/requests/${enc(id)}`,
    sends: {
      approve: { said: 'Approved', send: (note) => ({ method: 'POST', url, body: { decision: 'approve', ...(note ? { comment: note } : {}) } }) },
      reject: { said: 'Rejected', needsNote: 'A rejection needs a reason; say it as the note.', send: (note) => ({ method: 'POST', url, body: { decision: 'reject', comment: note } }) },
    },
  };
};

/** Access: one standing grant in a review (`<review>/<item>`), from the review's own read; keep or revoke. */
const reviewItem: Resolver = async (id, ctx) => {
  const [reviewId, itemId] = id.split('/');
  if (!reviewId || !itemId) return notWaiting('review item');
  const read = await readJson<{ items?: Rec[]; review?: Rec }>(ctx, `/api/access/reviews/${enc(reviewId)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('review item').result : readFailure('that review', read.status) };
  const row = (read.body.items ?? []).find((r) => r['id'] === itemId);
  if (!row || dig(row, 'can.decide') !== true) return notWaiting('review item');
  const url = `/api/access/reviews/${enc(reviewId)}/items/${enc(itemId)}/decide`;
  const who = str(dig(row, 'user.displayName')) ?? 'someone';
  return {
    title: `${who}'s ${String(row['role'] ?? 'role')} in ${String(row['tenant'] ?? 'the workspace')}`,
    detail: ['Approve keeps the grant; reject revokes it.'],
    href: `/access/reviews/${enc(reviewId)}`,
    sends: {
      approve: { said: 'Kept', send: (note) => ({ method: 'POST', url, body: { decision: 'keep', ...(note ? { comment: note } : {}) } }) },
      reject: { said: 'Revoked', needsNote: 'Revoking needs a reason; say it as the note.', send: (note) => ({ method: 'POST', url, body: { decision: 'revoke', comment: note } }) },
    },
  };
};

/** Pipelines: a step waiting on an approver (GET /api/pipelines/approvals), only for a role the step names. */
const stepApproval: Resolver = async (id, ctx) => {
  const read = await readJson<{ approvals?: Rec[] }>(ctx, '/api/pipelines/approvals');
  if (!read.ok) return { result: readFailure('the approvals', read.status) };
  const row = (read.body.approvals ?? []).find((r) => r['id'] === id);
  if (!row) return notWaiting('approval');
  const roles = Array.isArray(row['requiredRoles']) ? row['requiredRoles'] as string[] : [];
  // The page's own canDecide: a step names the roles that may decide it.
  if (roles.length && !roles.includes(ctx.role) && ctx.role !== 'admin') return { result: refused(`That step is decided by ${roles.join(' or ')}, not your role.`) };
  const url = `/api/pipelines/approvals/${enc(id)}/decide`;
  return {
    title: str(row['title']) ?? str(row['question']) ?? 'the step',
    detail: [...(str(row['question']) && str(row['title']) ? [String(row['question'])] : [])],
    href: '/pipelines/approvals',
    sends: {
      approve: { said: 'Approved', send: (note) => ({ method: 'POST', url, body: { decision: 'approve', note: note ?? null } }) },
      reject: { said: 'Rejected', send: (note) => ({ method: 'POST', url, body: { decision: 'reject', note: note ?? null } }) },
    },
  };
};

/** Work: a pending HITL transaction (GET /api/observability/approvals?status=PENDING); the card shows its amount. */
const hitlApproval: Resolver = async (id, ctx) => {
  const read = await readJson<{ approvals?: Rec[] }>(ctx, `/api/observability/approvals?${qs({ status: 'PENDING' })}`);
  if (!read.ok) return { result: readFailure('the pending approvals', read.status) };
  const row = (read.body.approvals ?? []).find((r) => r['approvalId'] === id);
  if (!row) return notWaiting('transaction');
  const amount = usd(dig(row, 'payload.amount'));
  const url = `/api/observability/approvals/${enc(id)}/decision`;
  return {
    title: str(row['reason']) ?? `the transaction from ${String(row['agentId'] ?? 'an agent')}`,
    detail: [amount ? `Amount: ${amount}.` : 'No amount given.', ...(str(row['agentId']) ? [`Requested by ${String(row['agentId'])}.`] : [])],
    href: '/admin/observability/approvals',
    sends: {
      approve: { said: 'Approved', send: (note) => ({ method: 'POST', url, body: { decision: 'APPROVED', ...(note ? { note } : {}) } }) },
      reject: { said: 'Rejected', send: (note) => ({ method: 'POST', url, body: { decision: 'REJECTED', ...(note ? { note } : {}) } }) },
    },
  };
};

/** Work: an agent change (GET /api/sdlc/changes/:id): decided while it awaits approval, delivered once approved. */
const change: Resolver = async (id, ctx) => {
  const read = await readJson<{ change?: Rec }>(ctx, `/api/sdlc/changes/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('change').result : readFailure('that change', read.status) };
  const c = read.body.change ?? {};
  const status = String(c['status'] ?? '');
  const decidable = status === 'needs_approval' || status === 'changes_requested';
  const url = (verb: string) => `/api/sdlc/changes/${enc(id)}/${verb}`;
  const sends: DecidePlan['sends'] = {};
  // The page's own gate (changesFormat changeActionGate): decide while it awaits approval, deliver once approved.
  // The author is not refused here: the route refuses them and says why (the card is the route's to answer).
  if (decidable) {
    sends.approve = { said: 'Approved', send: (note) => ({ method: 'POST', url: url('decide'), body: { decision: 'approve', ...(note ? { note } : {}) } }) };
    sends.reject = { said: 'Rejected', send: (note) => ({ method: 'POST', url: url('decide'), body: { decision: 'reject', ...(note ? { note } : {}) } }) };
  }
  if (status === 'approved') sends.deliver = { said: 'Delivered', send: () => ({ method: 'POST', url: url('deliver'), body: {} }) };
  if (!Object.keys(sends).length) return { result: refused(`"${str(c['title']) ?? id}" is ${status.replace(/_/g, ' ') || 'not open'}; there is nothing to decide on it.`) };
  return {
    title: `"${str(c['title']) ?? id}"`,
    detail: [`It is ${status.replace(/_/g, ' ')}.`, ...(str(c['repoFullName']) ? [`In ${String(c['repoFullName'])}.`] : []), ...(sends.deliver ? ['Delivering opens its pull request.'] : [])],
    href: `/admin/changes/${enc(id)}`,
    sends,
  };
};

/** Work: a runbook proposal (GET /api/runbooks/proposals/:pid, whose `can_review` is the page's own gate). */
const runbookProposal: Resolver = async (id, ctx) => {
  const read = await readJson<{ proposal?: Rec; runbook?: Rec | null; can_review?: boolean }>(ctx, `/api/runbooks/proposals/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('proposal').result : readFailure('that proposal', read.status) };
  const p = read.body.proposal ?? {};
  if (p['status'] !== 'open' || read.body.can_review !== true) return { result: refused('That proposal is not open for your review (yours, closed, or outside your initiatives).') };
  const title = str(dig(p, 'proposed.title')) ?? str(p['title']) ?? 'the proposal';
  const url = (verb: string) => `/api/runbooks/proposals/${enc(id)}/${verb}`;
  const version = read.body.runbook?.['current_version'];
  const sends: DecidePlan['sends'] = {
    reject: { said: 'Rejected', needsNote: 'A rejection needs a note for the proposer; say it as the note.', send: (note) => ({ method: 'POST', url: url('reject'), body: { note } }) },
  };
  // A new runbook's scope is chosen on its page; an edit is accepted against the version the page shows.
  if (p['kind'] !== 'new' && typeof version === 'number') {
    sends.approve = { said: 'Accepted', send: (note) => ({ method: 'POST', url: url('accept'), body: { expected_version: version, ...(note ? { note } : {}) } }) };
  }
  return {
    title: `"${title}"`,
    detail: [p['kind'] === 'new' ? 'A new runbook: accept it on its page, where its scope is chosen.' : `An edit to version ${String(version ?? '?')}.`],
    href: `/iq/runbooks/proposals/${enc(id)}`,
    sends,
  };
};

/** Work: a pending graph change proposal (GET /api/work/proposals?status=pending). */
const graphProposal: Resolver = async (id, ctx) => {
  const read = await readJson<{ proposals?: Rec[] }>(ctx, `/api/work/proposals?${qs({ status: 'pending' })}`);
  if (!read.ok) return { result: readFailure('the proposals', read.status) };
  const row = (read.body.proposals ?? []).find((r) => r['id'] === id);
  if (!row) return notWaiting('proposal');
  const url = `/api/work/proposals/${enc(id)}/decide`;
  return {
    title: str(row['rationale']) ?? `the ${String(row['kind'] ?? '')} proposal`.replace(/\s+/g, ' '),
    detail: [`${String(row['kind'] ?? 'A change')} on ${String(row['targetType'] ?? 'the graph')}.`],
    href: '/iq/work/changes',
    sends: {
      approve: { said: 'Approved', send: (note) => ({ method: 'POST', url, body: { decision: 'approve', ...(note ? { note } : {}) } }) },
      reject: { said: 'Rejected', send: (note) => ({ method: 'POST', url, body: { decision: 'reject', ...(note ? { note } : {}) } }) },
    },
  };
};

/** Work: a computer's pending consult (GET /api/lab/consults?status=pending); the answer is the user's note, verbatim on the card. */
const consult: Resolver = async (id, ctx) => {
  const read = await readJson<{ consults?: Rec[] }>(ctx, `/api/lab/consults?${qs({ status: 'pending' })}`);
  if (!read.ok) return { result: readFailure('the consults', read.status) };
  const row = (read.body.consults ?? []).find((r) => r['id'] === id);
  if (!row) return notWaiting('consult');
  return {
    title: `the consult "${str(row['question']) ?? id}"`,
    detail: [],
    href: '/iq/work',
    sends: { approve: { said: 'Answered', needsNote: 'Say the answer as the note.', send: (note) => ({ method: 'POST', url: `/api/lab/consults/${enc(id)}/answer`, body: { answer: note } }) } },
  };
};

/** Work: a design thread's sign-off (GET /api/designs/:id), while it is still open. */
const design: Resolver = async (id, ctx) => {
  const read = await readJson<Rec>(ctx, `/api/designs/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('design').result : readFailure('that design', read.status) };
  const status = String(read.body['status'] ?? '');
  if (['approved', 'rejected', 'superseded'].includes(status)) return { result: refused(`That design is already ${status}.`) };
  const url = `/api/designs/${enc(id)}/signoff`;
  return {
    title: `the "${str(read.body['title']) ?? id}" design`,
    detail: [`It is ${status.replace(/_/g, ' ')}${str(read.body['orgProjectName']) ? `, on ${String(read.body['orgProjectName'])}` : ''}.`],
    href: `/iq/designs/${enc(id)}`,
    sends: {
      approve: { said: 'Signed off', send: () => ({ method: 'POST', url, body: { decision: 'approve' } }) },
      reject: { said: 'Rejected', send: () => ({ method: 'POST', url, body: { decision: 'reject' } }) },
    },
  };
};

/** Assessment: a finished draft (GET /api/assessment/drafts/:runId) not yet decided: accept writes it into the team, discard drops it. */
const draft: Resolver = async (id, ctx) => {
  const read = await readJson<Rec>(ctx, `/api/assessment/drafts/${enc(id)}`);
  if (!read.ok) return { result: read.status === 404 ? notWaiting('draft').result : readFailure('that draft', read.status) };
  const d = read.body;
  if (d['phase'] !== 'completed') return { result: refused(`That draft is ${String(d['phase'] ?? 'not finished')}; decide it once it has finished.`) };
  if (d['decision'] != null) return { result: refused(`That draft was already ${String(d['decision'])}.`) };
  const url = (verb: string) => `/api/assessment/drafts/${enc(id)}/${verb}`;
  return {
    title: `the ${String(d['kind'] ?? '').replace(/[-_]/g, ' ')} draft`.replace(/\s+/g, ' '),
    detail: ['Accept writes it into the team; discard drops it.'],
    href: typeof d['teamId'] === 'string' ? `/assessment/teams/${enc(d['teamId'])}` : '/assessment/teams',
    sends: {
      approve: { said: 'Accepted', send: () => ({ method: 'POST', url: url('accept'), body: typeof d['revision'] === 'number' ? { baseRevision: d['revision'] } : {} }) },
      reject: { said: 'Discarded', send: () => ({ method: 'POST', url: url('discard'), body: {} }) },
    },
  };
};

/** The resolver per tenant and ref kind (the catalogue's DECIDE_ACTIONS has the same keys; the drift test holds them together). */
export const DECIDE_RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  orgiq: { 'hitl-approval': hitlApproval, change, 'runbook-proposal': runbookProposal, proposal: graphProposal, consult, design },
  assessment: { draft },
  pipelines: { approval: stepApproval },
  access: { approval: accessRequest, request: accessRequest, 'review-item': reviewItem },
};

const VERB_WORD: Readonly<Record<Verb, string>> = { approve: 'Approve', reject: 'Reject', deliver: 'Deliver' };

const planDecide: VoiceToolPlanner = async (args, ctx) => {
  let ref = String(args['ref']).trim();
  if (/^\d{1,2}$/.test(ref)) {
    const kept = ctx.results?.find(ref);
    if (!kept) return { result: refused(`There is no row ${ref} in the last result. List what is waiting first.`) };
    ref = kept.ref;
  }
  const parsed = parseRef(ref);
  if (!parsed) return { result: refused('Name the row by the ref a result gave, such as "approval:<id>", or its position. List what is waiting first.') };
  const kinds = DECIDE_ACTIONS[ctx.tenant] ?? {};
  const resolve = DECIDE_RESOLVERS[ctx.tenant]?.[parsed.kind];
  if (!(parsed.kind in kinds) || !resolve) return { result: refused(`A ${parsed.kind.replace(/-/g, ' ')} is not decided by voice in this workspace.`) };
  const verb = verbOf(String(args['decision']));
  const action = kinds[parsed.kind]![verb];
  if (action === undefined) return { result: refused(`A ${parsed.kind.replace(/-/g, ' ')} cannot be "${String(args['decision'])}".`) };
  // The page button's own action, before any request (prepareToolCall cannot: it depends on the ref and the decision).
  if (action && !ctx.can(action)) return { result: refused(`I can't ${String(args['decision'])} that with your role.`) };
  const row = await resolve(parsed.id, ctx);
  if ('result' in row) return row;
  const chosen = row.sends[verb];
  if (!chosen) return { result: refused(`${row.title} cannot be ${verb === 'approve' ? 'approved' : verb === 'reject' ? 'rejected' : 'delivered'} now; ${row.detail[0] ?? 'see its page'}`) };
  const note = typeof args['note'] === 'string' && args['note'].trim() ? args['note'].trim() : undefined;
  if (chosen.needsNote && !note && verb !== 'reject') return { result: refused(chosen.needsNote) };
  const both = !!row.sends.approve && !!row.sends.reject && verb !== 'deliver';
  const plan: DecidePlan = { kind: parsed.kind, id: parsed.id, title: row.title, sends: row.sends, verb, href: row.href, ...(note ? { note } : {}) };
  const card: ConfirmPlan = {
    title: `${VERB_WORD[verb]} ${row.title}`,
    detail: [...row.detail, ...(note ? [`Note: ${note}`] : [])],
    // Both ways open: the library's toggle and note, starting where the user said; Confirm answers { decision, note }.
    ...(both ? { fields: { decision: verb === 'reject' ? 'reject' : 'approve', notePlaceholder: row.sends.reject?.needsNote ? 'Reason (needed to reject)' : 'Note (optional)' } } : {}),
    data: plan,
  };
  return { plan: card };
};

/** The route's refusal as the route said it: the author, an already decided row, a role the route refuses. */
function decideRefusal(status: number, body: Rec | null, title: string): ToolResult {
  const error = str(body?.['error']);
  if (status === 0) return failed('Could not reach the server; nothing was decided.');
  if (body?.['gate'] === 'self-approval') return refused(`Not decided: ${error ?? 'you asked for this, so someone else must decide it'}.`);
  if (status === 401 || status === 403) return refused(`Not decided: ${error && !/^forbidden$/i.test(error) ? error : 'your role cannot decide that'}.`);
  if (status === 404) return refused(`${title} is no longer waiting; it may already be decided.`);
  if (status === 409) return refused(`Not decided: ${error ?? 'it was already decided'}.`);
  if (status === 400 || status === 422) return refused(`Not decided: ${error ?? 'the server refused it'}.`);
  return failed(`${title} could not be decided (HTTP ${status})${error ? `: ${error}` : ''}.`);
}

const runDecide: VoiceToolRunner = async (_args, ctx, planned, answer?: CardAnswer) => {
  const plan = planned as DecidePlan | undefined;
  if (!plan?.sends) return refused('A decision is sent only after the user confirms its card.');
  // The card's toggle and note win over the spoken arguments when the user clicked.
  const verb: Verb = answer && plan.verb !== 'deliver' ? answer.decision : plan.verb;
  const note = answer ? (answer.note.trim() || plan.note) : plan.note;
  const chosen = plan.sends[verb];
  if (!chosen) return refused(`${plan.title} cannot be ${verb === 'reject' ? 'rejected' : 'approved'} by voice.`);
  const action = DECIDE_ACTIONS[ctx.tenant]?.[plan.kind]?.[verb];
  if (action && !ctx.can(action)) return refused(`I can't ${verb} that with your role.`);
  if (chosen.needsNote && !note) return refused(`${chosen.needsNote} Nothing was decided.`);
  const send = chosen.send(note);
  return once(ctx, `${send.method} ${send.url} ${verb}`, async () => {
    let res: Response;
    try {
      res = await ctx.fetch(send.url, { method: send.method, credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(send.body) });
    } catch {
      return failed('Could not reach the server; nothing was decided.');
    }
    const body = await res.json().catch(() => null) as Rec | null;
    if (!res.ok) return decideRefusal(res.status, body, plan.title);
    const prUrl = str(body?.['prUrl']);
    return done('decided', { ref: `${plan.kind}:${plan.id}`, decision: verb, title: plan.title, href: plan.href, ...(note ? { note } : {}), ...(prUrl ? { delivered: true } : {}) },
      `${chosen.said}: ${plan.title}`);
  }, () => done('decided', { ref: `${plan.kind}:${plan.id}`, decision: verb, title: plan.title, alreadyDecided: true }, `${plan.title} was already decided; nothing was sent again`));
};

export const RECORD_PLANNERS: Readonly<Record<string, VoiceToolPlanner>> = { decide: planDecide };
export const RECORD_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = { decide: runDecide };

export type { VoiceToolArgs };
