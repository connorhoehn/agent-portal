// The access tenant's search projection (docs/user-search-goal.md S2).
//
// Doc types: request, catalog (what can be requested), policy (SoD), event
// (the audit trail), review (a campaign), review-item (one user's role under
// review) and delegation. Rows come from the store's list functions
// (providers/access.ts) and the live directory; names are resolved when a doc
// is built, so a doc is as fresh as the last write that touched it.
//
// WHO MAY SEE A DOC is not a Cedar action alone (a request is readable by its
// parties, the beneficiary's manager, whoever decided a step and whoever may
// decide the open step now). The route's rule (lib/access/rules.ts mayRead) is
// evaluated at build time into `record.vis` (ids, never names) and applied at
// query time by `visible`; update-on-write (providers/access.ts) re-projects a
// request on every transition, and a delegation change re-projects the open
// requests it moves.

import {
  listCatalog, listDelegations, listEvents, listPolicies, listRequests, listReviewItems, listReviews, listSteps,
  loadDirectory, type AccessCatalogRow, type AccessDelegationRow, type AccessEventRow, type AccessPolicyRow,
  type AccessRequestRow, type AccessReviewItemRow, type AccessReviewRow, type AccessStepRow,
} from '../../providers/access.js';
import { currentStep, isOpen } from '../access/status.js';
import { eligibleDeciders, personFor } from '../access/chain.js';
import { requestItem } from '../access/items.js';
import type { AccessDirectory } from '../access/types.js';
import { docKey, type SearchDoc, type SearchDocEdge } from './types.js';
import type { PhraseRule, TenantBuild, TenantIndexSpec, TenantSearchContext } from './tenants.js';

export const ACCESS_DOC_TYPES = ['request', 'catalog', 'policy', 'event', 'review', 'review-item', 'delegation'] as const;
export type AccessDocType = typeof ACCESS_DOC_TYPES[number];
const enc = encodeURIComponent;

/** Who may see a doc: evaluated at build time, applied by `visible`. */
interface Vis {
  /** request / event-of-request: the rule inputs of lib/access/rules.ts mayRead. */
  request?: { parties: string[]; deciders: string[]; eligible: string[]; managerPersonId: string | null };
  /** delegation and its events: the delegator and the delegate. */
  parties?: string[];
  /** policy events: DecideAccess holders. */
  decide?: boolean;
  /** a review item: DecideAccess holders and the user under review. */
  owner?: string;
}

const edge = (source: string, target: string, label: string): SearchDocEdge => ({ id: `${source}:${label}:${target}`, source, target, label });
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const DURATION: Record<string, string> = { '8h': '8 hours', '24h': '24 hours', '7d': '7 days', '30d': '30 days', standing: 'standing' };
const KIND_LABEL: Record<string, string> = {
  submitted: 'Submitted', 'step-approved': 'Step approved', 'step-rejected': 'Step rejected', 'info-requested': 'Information requested',
  withdrawn: 'Withdrawn', approved: 'Approved', provisioned: 'Provisioned', expired: 'Expired', revoked: 'Revoked',
  'sod-override': 'Policy override', 'sod-blocked': 'Blocked by policy', 'policy-updated': 'Policy updated', escalated: 'Escalated',
  delegated: 'Delegated', 'delegation-ended': 'Delegation ended',
};

function doc(tenant: string, type: AccessDocType, id: string, d: Partial<SearchDoc> & { title: string; record: Record<string, unknown> }): SearchDoc {
  return {
    tenant, type, id, title: d.title, text: d.text ?? '',
    facets: Object.fromEntries(Object.entries(d.facets ?? {}).map(([k, v]) => [k, [...new Set(v.filter(Boolean))]]).filter(([, v]) => (v as string[]).length)),
    people: [...new Set(d.people ?? [])], edges: d.edges ?? [], acl: d.acl ?? null, updatedAt: d.updatedAt ?? null, record: compact(d.record),
  };
}

interface World {
  dir: AccessDirectory;
  catalog: AccessCatalogRow[];
  steps: Map<string, AccessStepRow[]>;
  requests: Map<string, AccessRequestRow>;
}
const name = (w: World, id: string | null | undefined): string => (id ? personFor(w.dir, id)?.displayName ?? id : '');

async function readWorld(): Promise<World> {
  const dir = await loadDirectory();
  const steps = new Map<string, AccessStepRow[]>();
  for (const s of listSteps()) steps.set(s.requestId, [...(steps.get(s.requestId) ?? []), s]);
  for (const l of steps.values()) l.sort((a, b) => a.step - b.step);
  return { dir, catalog: listCatalog(), steps, requests: new Map(listRequests().map((r) => [r.id, r])) };
}

function requestVis(w: World, r: AccessRequestRow): NonNullable<Vis['request']> {
  const steps = w.steps.get(r.id) ?? [];
  const item = requestItem(r, w.catalog);
  const cur = currentStep(steps);
  const eligible = isOpen(r.status) && cur && item
    ? eligibleDeciders(cur.kind, item, r, w.dir, cur.escalationLevel).map((p) => p.id) : [];
  const beneficiary = w.dir.users.find((u) => u.id === r.beneficiaryId);
  return {
    parties: [...new Set([r.requesterId, r.beneficiaryId])],
    deciders: steps.map((s) => s.decidedBy).filter((x): x is string => !!x),
    eligible,
    managerPersonId: w.dir.managerOf(beneficiary?.personId ?? null),
  };
}

export function requestDoc(tenant: string, w: World, r: AccessRequestRow): SearchDoc {
  const item = requestItem(r, w.catalog);
  const steps = w.steps.get(r.id) ?? [];
  const vis = requestVis(w, r);
  const itemTitle = item?.title ?? r.itemId;
  const who = name(w, r.beneficiaryId), asker = name(w, r.requesterId);
  const cur = currentStep(steps);
  const decided = steps.filter((s) => s.decidedBy && (s.status === 'approved' || s.status === 'rejected'));
  const last = decided[decided.length - 1];
  const bits: string[] = [];
  if (isOpen(r.status) && vis.eligible.length) bits.push(`waiting on ${vis.eligible.map((id) => name(w, id)).join(', ')}`);
  else if (last) bits.push(`${last.status} by ${name(w, last.decidedBy)}`);
  const duration = DURATION[r.duration] ?? r.duration;
  const status = r.kind === 'revocation' ? `revocation ${r.status}` : r.status;
  const comments = steps.map((s) => s.comment ?? '').filter(Boolean).join(' ');
  const ref = docKey('request', r.id);
  return doc(tenant, 'request', r.id, {
    title: `${itemTitle} · ${who || asker}`,
    text: `${r.id} ${status} ${r.kind} ${r.justification} ${comments} requested by ${asker} for ${who} ${duration} ${r.duration === 'standing' ? 'standing' : 'temporary time-bound'} ${item?.sensitive ? 'sensitive' : ''} ${r.sodVerdict !== 'clear' ? `separation of duties ${r.sodVerdict}` : ''} ${cur ? `${cur.kind} step` : ''}`,
    facets: {
      status: [r.status], kind: [r.kind], requester: [r.requesterId], beneficiary: [r.beneficiaryId], party: vis.parties,
      decider: vis.deciders, eligible: vis.eligible, open: [isOpen(r.status) ? 'true' : 'false'],
      temporary: [r.duration === 'standing' ? 'false' : 'true'], duration: [r.duration], sensitive: [item?.sensitive ? 'true' : 'false'],
      item: [r.itemId], tenant: item ? [item.tenant] : [], manager: vis.managerPersonId ? [vis.managerPersonId] : [],
    },
    people: vis.parties, updatedAt: r.revokedAt ?? r.provisionedAt ?? r.decidedAt ?? r.submittedAt,
    edges: [edge(ref, docKey('catalog', r.itemId), 'requests'), ...(r.reviewId ? [edge(docKey('review', r.reviewId), ref, 'revocation')] : [])],
    record: {
      subtitle: [r.id, status, duration, ...bits].join(' · '),
      description: last?.comment ? `${last.status === 'rejected' ? 'Rejected' : 'Approved'} by ${name(w, last.decidedBy)}: ${last.comment}` : r.justification.split('\n')[0],
      status: r.status, href: `/access/requests/${enc(r.id)}`, vis: { request: vis } satisfies Vis,
      item: itemTitle, beneficiary: who || undefined, requester: asker || undefined,
    },
  });
}

export function catalogDoc(tenant: string, c: AccessCatalogRow): SearchDoc {
  return doc(tenant, 'catalog', c.id, {
    title: c.title,
    text: `${c.description} ${c.kind.replace('-', ' ')} ${c.tenant} ${c.role ?? ''} ${c.sensitive ? 'sensitive extra approval' : ''} ${DURATION[c.defaultDuration] ?? c.defaultDuration}`,
    facets: { kind: [c.kind], tenant: [c.tenant], sensitive: [c.sensitive ? 'true' : 'false'], duration: [c.defaultDuration] },
    record: {
      subtitle: `${c.tenant}${c.role ? ` · ${c.role}` : ''} · ${DURATION[c.defaultDuration] ?? c.defaultDuration}${c.sensitive ? ' · sensitive' : ''}`,
      description: c.description, href: `/access/requests/new?item=${enc(c.id)}`,
    },
  });
}

export function policyDoc(tenant: string, p: AccessPolicyRow): SearchDoc {
  return doc(tenant, 'policy', p.id, {
    title: p.title,
    text: `${p.id} separation of duties SoD conflict ${p.severity === 'block' ? 'blocking blocks' : 'warning warns'} ${p.reason} ${p.left.tenant} ${p.left.role} ${p.right.tenant} ${p.right.role}`,
    facets: { severity: [p.severity] }, updatedAt: p.updatedAt,
    record: { subtitle: `${p.severity === 'block' ? 'Blocks' : 'Warns'} · ${p.left.role} + ${p.right.role}`, description: p.reason, status: p.severity, href: `/access/policies/${enc(p.id)}` },
  });
}

export function eventDoc(tenant: string, w: World, e: AccessEventRow, delegations: Map<string, AccessDelegationRow>, policies: Map<string, AccessPolicyRow>): SearchDoc {
  const r = e.requestId ? w.requests.get(e.requestId) : undefined;
  const item = r ? requestItem(r, w.catalog) : undefined;
  const d = e.delegationId ? delegations.get(e.delegationId) : undefined;
  const p = e.policyId ? policies.get(e.policyId) : undefined;
  const subject = r ? `${item?.title ?? r.itemId} · ${name(w, r.beneficiaryId)}` : p ? p.title : d ? `Delegation · ${name(w, d.delegatorId)} to ${name(w, d.delegateId)}` : '';
  const label = KIND_LABEL[e.kind] ?? e.kind;
  const vis: Vis = r ? { request: requestVis(w, r) } : d ? { parties: [d.delegatorId, d.delegateId] } : { decide: true };
  return doc(tenant, 'event', e.id, {
    title: `${label} · ${subject}`.replace(/ · $/, ''),
    text: `${e.kind} ${label} ${e.requestId ?? ''} ${e.policyId ?? ''} ${e.delegationId ?? ''} ${name(w, e.actorId)} ${e.reason ?? ''} ${e.kind === 'sod-override' ? 'override overrode' : ''} audit`,
    facets: { kind: [e.kind], actor: e.actorId ? [e.actorId] : [], request: e.requestId ? [e.requestId] : [] },
    people: e.actorId ? [e.actorId] : [], updatedAt: e.at,
    edges: e.requestId ? [edge(docKey('event', e.id), docKey('request', e.requestId), 'about')] : [],
    record: {
      subtitle: [e.requestId ?? e.policyId ?? e.delegationId, name(w, e.actorId) || 'system', e.beforeStatus && e.afterStatus ? `${e.beforeStatus} → ${e.afterStatus}` : ''].filter(Boolean).join(' · '),
      description: e.reason ?? undefined, href: e.requestId ? `/access/requests/${enc(e.requestId)}` : '/access/audit', vis,
    },
  });
}

export function reviewDoc(tenant: string, w: World, v: AccessReviewRow, items: AccessReviewItemRow[]): SearchDoc {
  const undecided = items.filter((i) => i.decision === null);
  return doc(tenant, 'review', v.id, {
    title: v.title,
    text: `${v.id} access review campaign certification ${v.tenant} ${v.status} owner ${name(w, v.openedBy)}`,
    facets: { status: [v.status], tenant: [v.tenant] }, updatedAt: v.closedAt ?? v.openedAt,
    edges: items.map((i) => edge(docKey('review', v.id), docKey('review-item', i.id), 'item')),
    record: { subtitle: `${v.status} · ${items.length - undecided.length} of ${items.length} decided`, status: v.status, href: `/access/reviews/${enc(v.id)}` },
  });
}

export function reviewItemDoc(tenant: string, w: World, i: AccessReviewItemRow, review: AccessReviewRow | undefined): SearchDoc {
  const state = i.decision ?? 'undecided';
  return doc(tenant, 'review-item', i.id, {
    title: `${name(w, i.userId)} · ${i.role} in ${i.tenant}`,
    text: `${i.id} ${state} ${i.decision ? `decided by ${name(w, i.decidedBy)}` : 'needs a decision'} ${i.comment ?? ''} ${review?.title ?? ''} review certification`,
    facets: { decision: [state], user: [i.userId], review: [i.reviewId] }, people: [i.userId], updatedAt: i.decidedAt,
    edges: [edge(docKey('review', i.reviewId), docKey('review-item', i.id), 'item')],
    record: { subtitle: `${review?.title ?? i.reviewId} · ${state}`, description: i.comment ?? undefined, status: state, href: `/access/reviews/${enc(i.reviewId)}`, vis: { owner: i.userId } satisfies Vis },
  });
}

export function delegationDoc(tenant: string, w: World, d: AccessDelegationRow, now: number): SearchDoc {
  const state = d.endedAt || Date.parse(d.endsAt) <= now ? 'ended' : Date.parse(d.startsAt) > now ? 'scheduled' : 'active';
  return doc(tenant, 'delegation', d.id, {
    title: `Delegation · ${name(w, d.delegatorId)} to ${name(w, d.delegateId)}`,
    text: `${d.id} ${state} covers approvals while away delegate delegator ${d.reason}`,
    facets: { state: [state], delegator: [d.delegatorId], delegate: [d.delegateId] }, people: [d.delegatorId, d.delegateId], updatedAt: d.endedAt ?? d.createdAt,
    record: { subtitle: `${d.id} · ${name(w, d.delegateId)} covers ${name(w, d.delegatorId)} · ${state}`, description: d.reason, status: state, href: '/access/approvals', vis: { parties: [d.delegatorId, d.delegateId] } satisfies Vis },
  });
}

async function all(tenant: string): Promise<SearchDoc[]> {
  const w = await readWorld();
  const delegations = listDelegations(), policies = listPolicies(), reviews = listReviews(), items = listReviewItems();
  const dmap = new Map(delegations.map((d) => [d.id, d])), pmap = new Map(policies.map((p) => [p.id, p]));
  const now = Date.now();
  return [
    ...w.catalog.map((c) => catalogDoc(tenant, c)),
    ...[...w.requests.values()].map((r) => requestDoc(tenant, w, r)),
    ...policies.map((p) => policyDoc(tenant, p)),
    ...listEvents().map((e) => eventDoc(tenant, w, e, dmap, pmap)),
    ...reviews.map((v) => reviewDoc(tenant, w, v, items.filter((i) => i.reviewId === v.id))),
    ...items.map((i) => reviewItemDoc(tenant, w, i, reviews.find((v) => v.id === i.reviewId))),
    ...delegations.map((d) => delegationDoc(tenant, w, d, now)),
  ];
}

async function build(partition: string): Promise<TenantBuild> {
  try { return { docs: await all(partition), partial: [], failed: false }; }
  catch { return { docs: [], partial: ['Access records unavailable'], failed: true }; }
}

async function project(partition: string, type: string, id: string): Promise<SearchDoc | null> {
  const w = await readWorld();
  switch (type as AccessDocType) {
    case 'request': { const r = w.requests.get(id); return r ? requestDoc(partition, w, r) : null; }
    case 'catalog': { const c = w.catalog.find((x) => x.id === id); return c ? catalogDoc(partition, c) : null; }
    case 'policy': { const p = listPolicies().find((x) => x.id === id); return p ? policyDoc(partition, p) : null; }
    case 'event': {
      const e = listEvents().find((x) => x.id === id);
      return e ? eventDoc(partition, w, e, new Map(listDelegations().map((d) => [d.id, d])), new Map(listPolicies().map((p) => [p.id, p]))) : null;
    }
    case 'review': { const v = listReviews().find((x) => x.id === id); return v ? reviewDoc(partition, w, v, listReviewItems(id)) : null; }
    case 'review-item': { const i = listReviewItems().find((x) => x.id === id); return i ? reviewItemDoc(partition, w, i, listReviews().find((v) => v.id === i.reviewId)) : null; }
    case 'delegation': { const d = listDelegations().find((x) => x.id === id); return d ? delegationDoc(partition, w, d, Date.now()) : null; }
    default: return null;
  }
}

/** The route's read rules, applied to the ids a doc carries (lib/access/rules.ts, routes/access.ts). */
function visible(d: SearchDoc, ctx: TenantSearchContext): boolean {
  const vis = d.record['vis'] as Vis | undefined;
  if (!vis) return true;
  const admin = ctx.principal.role === 'access-admin' || ctx.principal.role === 'admin';
  if (vis.request) {
    const q = vis.request;
    return admin || q.parties.includes(ctx.userId) || q.deciders.includes(ctx.userId) || q.eligible.includes(ctx.userId)
      || (!!ctx.personId && q.managerPersonId === ctx.personId);
  }
  if (vis.parties) return admin || vis.parties.includes(ctx.userId);
  if (vis.decide) return ctx.allowedAcls.includes('DecideAccess');
  if (vis.owner) return ctx.allowedAcls.includes('DecideAccess') || vis.owner === ctx.userId;
  return true;
}

const OPEN_MINE = { types: ['request'], facets: { party: ['@me'], open: ['true'] } };
export const accessRules: PhraseRule[] = [
  // possessives and filler that would otherwise be search words
  { re: /'s\b/ },
  { re: /\bwhile i(?:'?m| am) away\b/ },
  { re: /\bi'?m\b/ },
  { re: /\bgrants?\b/ },
  { re: /\bjoin(?:ing)?\b/ },
  // delegation
  { re: /\b(?:who )?covers? my approvals\b|\bdelegat\w*\b|\bwho covers\b/, types: ['delegation'] },
  // approvals waiting on the reader
  { re: /\bwaiting (?:on|for) me\b|\bwaiting for my (?:approval|decision)\b|\bneeds? my (?:approval|decision)\b|\bi need to (?:approve|decide)\b|\b(?:approvals?|decisions?) pending\b|\bpending approvals?\b|\bawaiting me\b/, types: ['request'], facets: { eligible: ['@me'], open: ['true'] } },
  { re: /\bwhat am i waiting on\b|\bmy (?:pending|open|outstanding|waiting)\b/, ...OPEN_MINE },
  { re: /\bi withdrew\b/, types: ['request'], facets: { status: ['withdrawn'], party: ['@me'] } },
  { re: /\bwithdr(?:awn|aw|ew|awals?)\b/, types: ['request'], facets: { status: ['withdrawn'] } },
  { re: /\brejected\b|\bdenied\b|\bdeclined\b/, types: ['request'], facets: { status: ['rejected'] } },
  { re: /\bclosed\b/, types: ['request'], facets: { status: ['rejected', 'withdrawn', 'expired', 'revoked'] } },
  { re: /\bexpired\b/, types: ['request'], facets: { status: ['expired'] } },
  { re: /\btemporary\b|\btime[- ]bound\b|\bexpiring\b|\bexpires?\b|\blapses?\b/, types: ['request'], facets: { temporary: ['true'] } },
  { re: /\bsensitive\b|\bneeds? extra approval\b|\bextra approval\b/, types: ['catalog'], facets: { sensitive: ['true'] } },
  // reports
  { re: /\b(?:requests )?from my reports\b|\bmy reports\b/, types: ['request'], facets: { manager: ['@person'] } },
  // audit and approvals history
  { re: /\boverrid\w*\b/, types: ['event'], facets: { kind: ['sod-override'] } },
  { re: /\bwho (?:approved|decided|signed off)\b/, types: ['request', 'event'] },
  // policies
  { re: /\bblocking\b|\bblocks\b/, types: ['policy'], facets: { severity: ['block'] } },
  { re: /\bseparation of duties\b|\bsegregation of duties\b|\bsod\b/, types: ['policy'] },
  // reviews
  { re: /\bopen (?:reviews?|campaigns?)\b/, types: ['review'], facets: { status: ['open'] } },
  { re: /\bundecided\b|\bstill needs? a decision\b|\bnot (?:yet )?decided\b/, types: ['review-item'], facets: { decision: ['undecided'] } },
  // open requests, anyone's
  { re: /\bpending\b|\bopen\b|\boutstanding\b|\bin flight\b/, types: ['request'], facets: { open: ['true'] } },
  // "my ..." with nothing narrower: the reader's own requests
  { re: /\bmy\b|\bmine\b/, types: ['request'], facets: { party: ['@me'] } },
];

export const accessSpec: TenantIndexSpec = {
  tenant: 'access',
  types: ACCESS_DOC_TYPES,
  // 'review-item' before 'review' so the word "review" names campaigns and "item" names review items.
  labels: { request: 'Request', catalog: 'Catalog entry', policy: 'Policy', event: 'Audit event', 'review-item': 'Review item', review: 'Review', delegation: 'Delegation' },
  acls: ['DecideAccess'],
  build, project, rules: accessRules, visible,
  scaffold: ['access', 'roles', 'role', 'policies', 'entries', 'asked', 'conflicts', 'conflict', 'campaign', 'campaigns', 'covers', 'away'],
};
