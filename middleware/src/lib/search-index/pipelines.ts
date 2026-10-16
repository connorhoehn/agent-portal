// The pipelines tenant's search projection (docs/user-search-goal.md S2).
//
// The tenant owns no tables of its own: every record is DERIVED (the run
// projection, the definition registry, the approval inbox, the queue
// inventory), so this module reads the same providers the pages read and files
// what they return:
//
//   run         every projected run (agent, bot, project, assessment, compaction): status, cost, error
//   definition  assessment commands and agents (the registry's non-bot, non-runbook rows)
//   runbook     runbook definitions, with whether any dry run exists
//   bot         the bots (a bot's definition page is /pipelines/definitions/bot:<id>)
//   approval    pending approvals and the change requests already decided (who approved what)
//   queue       the observed queues, dead-letter ones marked
//   artifact    run artifacts (traces, transcripts, changes, documents, scores)
//
// Writers: the pipelines providers (definitions, approvals, cancel, dry run),
// bots and the job/change/consult sources they derive from call
// `noteSearchWrite({ tenant: 'pipelines', … })` after their commit. A record is
// re-read by building the projection again and picking the doc out — these
// sources are cheap in the mock and bounded windows on the cluster.

import { loadProjection } from '../../providers/pipeline-runs.js';
import { loadDefinitions, listApprovals, listRunRecords } from '../../providers/pipeline-definitions.js';
import { listChangeRequests } from '../../providers/sdlc.js';
import { listBots, type Bot } from '../../providers/bots.js';
import { readPipelineQueues } from '../pipeline-queues.js';
import { userNameFor } from '../user-names.js';
import type { Definition } from '../pipeline-definitions.js';
import type { Artifact, Run } from '../pipeline-runs.js';
import { docKey, type SearchDoc } from './types.js';
import type { PhraseRule, TenantBuild, TenantIndexSpec } from './tenants.js';

export const PIPELINES_DOC_TYPES = ['run', 'definition', 'runbook', 'bot', 'approval', 'queue', 'artifact'] as const;
export type PipelinesDocType = typeof PIPELINES_DOC_TYPES[number];

const enc = encodeURIComponent;
const compact = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));
const money = (n: number | null | undefined) => (n == null ? null : `$${n.toFixed(2)}`);
const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : null);
const humanSlug = (slug: string) => { const w = slug.replace(/^promo-/, '').replace(/[-_]+/g, ' '); return w.charAt(0).toUpperCase() + w.slice(1); };

function doc(tenant: string, type: PipelinesDocType, id: string, d: Partial<SearchDoc> & { title: string; record: Record<string, unknown> }): SearchDoc {
  return {
    tenant, type, id, title: d.title, text: d.text ?? '',
    facets: Object.fromEntries(Object.entries(d.facets ?? {}).map(([k, v]) => [k, [...new Set(v.filter(Boolean))]]).filter(([, v]) => v.length)),
    people: [...new Set(d.people ?? [])], edges: d.edges ?? [], acl: null, updatedAt: d.updatedAt ?? null, record: compact(d.record),
  };
}

// ── per-type docs ────────────────────────────────────────────────────────────

export function runDoc(tenant: string, r: Run, definitionTitle: string | null): SearchDoc {
  const error = r.context.error ?? null;
  const cost = money(r.costUsd);
  const workspace = r.tenant === 'assessment' ? 'assessment' : r.tenant === 'orgiq' ? 'orgiq' : r.tenant;
  const subtitle = [r.status, definitionTitle, cost, r.ownerName ? `Owner: ${r.ownerName}` : null, day(r.startedAt)].filter(Boolean).join(' · ');
  return doc(tenant, 'run', r.id, {
    title: r.context.title || definitionTitle || r.id,
    text: [r.id.replace(/[:_]/g, ' '), r.status, error, definitionTitle, r.definitionId, r.triggeredByName, r.ownerName, r.context.initiativeName, r.context.kind, r.triggerType, `${workspace} workspace`, cost].filter(Boolean).join(' '),
    facets: {
      status: [r.status], kind: [r.context.kind], workspace: [workspace], definition: [r.definitionId], bot: [r.context.botId ?? ''],
      cost: [r.costUsd != null && r.costUsd >= 0.5 ? 'high' : ''],
    },
    people: r.triggeredBy ? [r.triggeredBy] : [],
    updatedAt: r.startedAt,
    record: { subtitle, description: error ?? undefined, status: r.status, href: `/pipelines/runs/${enc(r.id)}` },
  });
}

function stepDetail(d: Definition): string {
  return d.steps.map(s => `${s.label} ${s.detail ?? ''}`).join(' ');
}

export function definitionDoc(tenant: string, d: Definition): SearchDoc {
  const runsAs = stepDetail(d).match(/\b(orgiq-[a-z-]+)\b/)?.[1] ?? null;
  const subtitle = [d.kind === 'assessment-command' ? 'Assessment command' : 'Agent', d.ownerName ? `Owner: ${d.ownerName}` : d.owner ? `Owner: ${d.owner}` : null, runsAs ? `runs as ${runsAs}` : null, d.enabled ? null : 'disabled'].filter(Boolean).join(' · ');
  return doc(tenant, 'definition', d.id, {
    title: d.title,
    text: [d.id.replace(/[:_]/g, ' '), d.description, stepDetail(d), d.ownerName, d.owner, d.kind, runsAs, 'command'].filter(Boolean).join(' '),
    facets: { kind: [d.kind], owner: [d.owner ?? ''], enabled: [String(d.enabled)] },
    people: d.owner ? [d.owner] : [],
    record: { subtitle, description: d.description ?? undefined, href: `/pipelines/definitions/${enc(d.id)}` },
  });
}

export function runbookDoc(tenant: string, d: Definition, dryRuns: number): SearchDoc {
  const candidate = String(d.meta['candidateId'] ?? d.source.id);
  const status = String(d.meta['candidateStatus'] ?? '');
  const subtitle = [`Runbook · ${humanSlug(candidate)}`, status || null, dryRuns ? `${dryRuns} dry-run${dryRuns === 1 ? '' : 's'}` : 'no dry run yet', d.ownerName ? `Owner: ${d.ownerName}` : null].filter(Boolean).join(' · ');
  return doc(tenant, 'runbook', d.id, {
    title: d.title,
    text: [candidate.replace(/[-_]/g, ' '), humanSlug(candidate), d.description, stepDetail(d), d.ownerName, status, 'runbook'].filter(Boolean).join(' '),
    facets: { dryRun: [dryRuns ? 'done' : 'none'], status: [status], owner: [d.owner ?? ''] },
    people: d.owner ? [d.owner] : [],
    record: { subtitle, description: d.description ?? undefined, href: `/pipelines/definitions/${enc(d.id)}` },
  });
}

export function botDoc(tenant: string, b: Bot): SearchDoc {
  const waiting = !b.agentProjectRepo;
  const reason = !b.enabled ? 'disabled' : b.pausedReason ? `paused: ${b.pausedReason}` : waiting ? 'parked, awaiting repo provisioning' : null;
  const subtitle = [reason ?? 'active', `${b.trigger}${b.cronExpr ? ` ${b.cronExpr}` : ''}`, b.lastRunAt ? `last run ${day(b.lastRunAt)}` : 'never run', b.orgProjectName].filter(Boolean).join(' · ');
  return doc(tenant, 'bot', b.id, {
    title: b.name,
    text: [b.name.replace(/-/g, ' '), b.prompt, b.orgProjectName, b.template, b.trigger, reason, b.createdBy ? userNameFor(b.createdBy) : null, 'bot last run'].filter(Boolean).join(' '),
    facets: { inactive: [reason ? 'true' : 'false'], enabled: [String(b.enabled)], trigger: [b.trigger] },
    people: b.createdBy ? [b.createdBy] : [],
    updatedAt: b.lastRunAt ?? b.createdAt,
    record: { subtitle, description: b.prompt, status: reason ? 'paused' : 'active', href: `/pipelines/definitions/${enc(`bot:${b.id}`)}` },
  });
}

interface ApprovalFacts { id: string; title: string; question?: string | null; detail?: string | null; state: string; decidedBy?: string | null; decidedAt?: string | null; requestedAt?: string | null; source: string }
export function approvalDoc(tenant: string, a: ApprovalFacts): SearchDoc {
  const by = a.decidedBy ? userNameFor(a.decidedBy) ?? a.decidedBy : null;
  const label = a.state === 'pending' ? 'Waiting for approval' : a.state.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const subtitle = [label, by ? `decided by ${by}` : null, a.source === 'agent_change_requests' ? 'change review' : a.source === 'lab_consults' ? 'question to a person' : 'job review'].filter(Boolean).join(' · ');
  return doc(tenant, 'approval', a.id, {
    title: a.title,
    text: [a.question, a.detail, label, by ? `approved decided by ${by}` : null, 'approval'].filter(Boolean).join(' '),
    facets: { approvalState: [a.state], decider: [a.decidedBy ?? ''] },
    people: a.decidedBy ? [a.decidedBy] : [],
    updatedAt: a.decidedAt ?? a.requestedAt ?? null,
    record: { subtitle, description: a.question ?? a.detail ?? undefined, status: a.state, href: `/pipelines/approvals/${enc(a.id)}` },
  });
}

interface QueueFacts { name: string; purpose: string; deadLetter: boolean; redriveTo: string | null; ready: number | null; inFlight: number | null; state: string }
export function queueDoc(tenant: string, q: QueueFacts): SearchDoc {
  const depth = q.ready == null ? 'depth not readable' : `${q.ready} ready, ${q.inFlight ?? 0} in flight`;
  const kind = q.deadLetter ? 'Dead-letter queue' : 'Queue';
  return doc(tenant, 'queue', q.name, {
    title: q.name,
    text: [q.name.replace(/-/g, ' '), q.purpose, kind, q.deadLetter ? 'dead letter DLQ failed deliveries' : '', q.redriveTo ? `redrives to ${q.redriveTo}` : ''].filter(Boolean).join(' '),
    facets: { deadLetter: [String(q.deadLetter)], state: [q.state] },
    record: { subtitle: `${kind} · ${depth}`, description: q.purpose, href: '/pipelines/queues' },
  });
}

export function artifactDoc(tenant: string, a: Artifact): SearchDoc {
  return doc(tenant, 'artifact', a.id, {
    title: a.title || a.id,
    text: [a.kind, `${a.kind} artifact`, a.runId?.replace(/[:_]/g, ' ')].filter(Boolean).join(' '),
    facets: { kind: [a.kind] },
    updatedAt: a.createdAt,
    record: { subtitle: `${a.kind.replace(/^./, c => c.toUpperCase())} artifact${a.runId ? ` · ${a.runId}` : ''}`, href: a.runId ? `/pipelines/runs/${enc(a.runId)}` : '/pipelines/artifacts' },
  });
}

// ── the rebuild ──────────────────────────────────────────────────────────────

export async function buildPipelinesDocs(tenant: string): Promise<TenantBuild> {
  const partial: string[] = [];
  let failed = false;
  async function read<T>(name: string, p: Promise<T>, fallback: T): Promise<T> {
    try { return await p; } catch { partial.push(`${name} unavailable`); failed = true; return fallback; }
  }
  const [projection, defs, approvals, changes, queues, bots] = await Promise.all([
    read('Runs', loadProjection(), null),
    read('Definitions', loadDefinitions(), null),
    read('Approvals', listApprovals(), null),
    read('Changes', listChangeRequests(), []),
    read('Queues', readPipelineQueues(), null),
    read('Bots', listBots(), []),
  ]);
  const records = await read('Dry runs', listRunRecords(), []);
  for (const u of projection?.unavailable ?? []) partial.push(`${u.table} unavailable`);
  for (const u of defs?.unavailable ?? []) partial.push(`${u.source} unavailable`);
  const docs: SearchDoc[] = [];
  const titles = new Map((defs?.definitions ?? []).map(d => [d.id, d.title]));
  projection?.runs.forEach(r => docs.push(runDoc(tenant, r, titles.get(r.definitionId) ?? null)));
  projection?.artifacts.forEach(a => docs.push(artifactDoc(tenant, a)));
  const dryRunsOf = (id: string) => records.filter(r => r.definitionId === id).length;
  for (const d of defs?.definitions ?? []) {
    if (d.kind === 'bot') continue;
    docs.push(d.kind === 'runbook' ? runbookDoc(tenant, d, dryRunsOf(d.id)) : definitionDoc(tenant, d));
  }
  bots.forEach(b => docs.push(botDoc(tenant, b)));
  // Pending approvals first; a change already decided stays searchable with who decided it.
  const pending = new Set((approvals?.approvals ?? []).map(a => a.id));
  for (const a of approvals?.approvals ?? []) docs.push(approvalDoc(tenant, { id: a.id, title: a.title, question: a.question, detail: a.detail, state: 'pending', requestedAt: a.requestedAt, source: a.source }));
  for (const c of changes) {
    const id = `change:${c.id}`;
    if (pending.has(id)) continue;
    docs.push(approvalDoc(tenant, { id, title: c.title, detail: [c.repoFullName, c.orgProjectName, c.decisionNote].filter(Boolean).join(' · '), state: c.status || 'captured', decidedBy: c.decidedBy, decidedAt: c.decidedAt, requestedAt: c.createdAt, source: 'agent_change_requests' }));
  }
  for (const q of queues?.queues ?? []) docs.push(queueDoc(tenant, { name: q.name, purpose: q.purpose, deadLetter: q.deadLetter, redriveTo: q.redriveTo, ready: q.snapshot?.ready ?? null, inFlight: q.snapshot?.inFlight ?? null, state: q.state }));
  return { docs, partial: [...new Set(partial)], failed };
}

export async function projectPipelinesRecord(partition: string, type: string, id: string): Promise<SearchDoc | null> {
  const built = await buildPipelinesDocs(partition);
  return built.docs.find(d => d.type === type && d.id === id) ?? null;
}

// ── phrases ──────────────────────────────────────────────────────────────────

const RULES: PhraseRule[] = [
  { re: /\bassessment (?:command )?runs?\b|\bruns? (?:from|in|of) the assessment workspace\b|\bassessment workspace\b/, types: ['run'], facets: { workspace: ['assessment'] } },
  { re: /\bwho (?:approved|decided|signed off|rejected|reviewed)\b|\bapproved by\b|\bapprovals? history\b/, types: ['approval'] },
  { re: /\b(?:waiting|awaiting|pending|outstanding)\b|\bneeds? to (?:decide|approve|review)\b|\bto decide\b|\bi need to decide\b/, types: ['approval'], facets: { approvalState: ['pending'] } },
  { re: /\bdead[- ]?letter\b|\bdlq\b/, types: ['queue'], facets: { deadLetter: ['true'] } },
  { re: /\b(?:never|without|no|needs?|needing)\b[^.]{0,20}\bdry[- ]?runs?\b/, types: ['runbook'], facets: { dryRun: ['none'] } },
  { re: /\btranscripts?\b/, types: ['artifact'], facets: { kind: ['transcript'] } },
  { re: /\b(?:most )?(?:expensive|costliest|costly)\b|\bcosts?\b|\bspend\b|\bspent\b/, types: ['run'], facets: { cost: ['high'] } },
  { re: /\b(?:paused|disabled|parked|inactive|stopped)\b/, types: ['bot'], facets: { inactive: ['true'] } },
  { re: /\bfail(?:ed|ing|ures?|ure)?\b|\berrors?\b|\berrored\b/, types: ['run'], facets: { status: ['failed'] } },
  { re: /\b(?:running|in[- ]?flight|in[- ]?progress)\b/, types: ['run'], facets: { status: ['running'] } },
  { re: /\bretried\b|\bretry\b/, types: ['run'] },
  // A named kind of record keeps the search inside it (no stray hits on a shared word like "group").
  { re: /\brunbooks?\b/, types: ['runbook'] },
  { re: /\bbots?\b/, types: ['bot'] },
  { re: /\bqueues?\b/, types: ['queue'] },
  { re: /\bapprovals?\b/, types: ['approval'] },
  { re: /\bartifacts?\b/, types: ['artifact'] },
  { re: /\bdefinitions?\b/, types: ['definition', 'runbook'] },
  { re: /\blast ran\b|\blast run\b|\bwhen did\b/ },
  { re: /\bthis (?:week|month)\b|\btoday\b|\bnow\b/ },
  { re: /\bowners? of\b|\bowns?\b|\bowner\b/ },
];

export const pipelinesSpec: TenantIndexSpec = {
  tenant: 'pipelines',
  types: PIPELINES_DOC_TYPES,
  labels: { run: 'Run', definition: 'Definition', runbook: 'Runbook', bot: 'Bot', approval: 'Approval', queue: 'Queue', artifact: 'Artifact' },
  acls: [],
  scaffold: ['s', 'did', 'command', 'commands', 'workspace', 'pipeline', 'pipelines'],
  build: buildPipelinesDocs,
  project: projectPipelinesRecord,
  rules: RULES,
};
void docKey;
