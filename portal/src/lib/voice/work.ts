// queue_work (docs/voice-navigator-gaps.md G19): background work the voice
// queues, one toast that follows it, the notification center's entry and the
// spoken outcome.
//
// The planner runs before the card, reads only: the kind must be one of the
// session tenant's (QUEUE_WORK_KINDS) and can() must hold the page button's
// action (QUEUE_WORK_ACTIONS), both checked before any request; then the
// target is resolved by the read the page itself lists from (the sweep names,
// GET /api/bots, GET /api/pipelines/runbooks), so the card names exactly the
// sweep, bot or runbook that will run. A cancel leaves nothing behind.
//
// The runner, once confirmed, calls the route the page's button calls, with
// the button's body and none of the over-budget confirm flags: a run the money
// brakes stop is answered as a refusal that names the page, never pushed
// through by voice. The voice's `note` is a label on the card and the toast;
// it is never sent (a bot run's `instruction` steers an agent, and model text
// never reaches a prompt, as with computer run's phrases).
//
//   sweep    POST /api/work/sweeps/run { sweep?, background: true } -> 202 { jobId }
//   bot-run  POST /api/bots/:id/run {}                              -> 202 { run: { id } }
//   pipeline POST /api/pipelines/definitions/:id/dry-run {}         -> 202 { run: { id } }
//
// Catalogue v2 (V2-9) adds the kinds the catalogue's QUEUE_WORK_ACTIONS
// lists per tenant, each resolved by the kind's own list read (tools.ts
// findByName, the page's gate first) and sent as a PostSpec the planner
// fixes: the suggested job (its own prompt), a work item's dispatch (the
// drawer's forecast from GET /api/bots/estimate on the card), a finding's
// promote and analysis, a change's re-review and address, a deck in each
// tenant, the conversation commands with no text (the recent conversation,
// as a bare /summarize reads it), the scorer and a dimension's drafts. A kind
// whose route answers with a job id is followed by the read its page polls
// (QueuedJob.follow); one the route finishes while answering gets one settled
// toast (VoiceJobTracker.finished). Every one goes through the action ledger
// (tools.ts once), so a retry never queues twice. agent-plan is not offered:
// its route needs a goal, which is free text to an agent.
//
// The id the toast is keyed on is the one in that response; the model never
// supplies one (the schema has no such argument and refuses any it sends).
// One background sweep per person: a 409 `sweep-job-running` names the sweep
// already running, and the runner follows THAT job (its toast, its spoken
// outcome) and says nothing new was queued, instead of failing.
//
// VoiceJobTracker follows each job to the end: a read of its state when the
// stream the page already holds says something moved (GET /api/work/events in
// orgiq, which the sweep jobs and the dispatcher's jobs both emit on; GET
// /api/pipelines/runs/:id/events in pipelines), and a slower poll in case the
// stream is down. Every change calls the library's toastJob with the same id,
// so one toast moves queued -> running -> done (with the page link) or failed
// (with the error); the library removes it `toastSeconds` after it settles and
// calls onSettled once, which mirrors the outcome into the notification center
// and, while a session is live, has the voice say it.
//
// No React and only `.ts` imports, so `node --test` runs it.

import type { Notification } from '@connorhoehn/realtime-modules/client';
import { QUEUE_WORK_ACTIONS, type QueueWorkKind } from './catalogue.ts';
import { DEFAULT_DEVBOX_MODEL, DEVBOX_MODELS } from '../devboxModels.ts';
import {
  ambiguous, done, failed, findByName, localHref, once, pageRowAt, pageRowNamed, qs, readFailure, readJson, refused,
  type ConfirmPlan, type JobFollow, type JobTracking, type QueuedJob, type ToolContext, type ToolResult, type VoiceToolArgs, type VoiceToolPlanner, type VoiceToolRunner,
} from './tools.ts';
import type { PageRow } from './pageContext.ts';
import { deriveJob, dispatchBlockedReason, dispatchBody, modelLabel } from '../../pages/project-detail/prepareJobModel.ts';
import { flattenWorkItems } from '../../pages/project-detail/projectFormat.ts';
import type { Codebase, WorkItemTree } from '../../pages/project-detail/types.ts';

// ── targets ─────────────────────────────────────────────────────────────────

export type SweepName = 'bus_factor' | 'stale_docs' | 'orphan_decisions';
const SWEEP_LABEL: Record<SweepName, string> = { bus_factor: 'bus factor', stale_docs: 'stale docs', orphan_decisions: 'orphan decisions' };
const SWEEP_WORDS: Array<[RegExp, SweepName]> = [
  [/\b(bus|factor)\b/, 'bus_factor'],
  [/\b(stale|docs?|documents?)\b/, 'stale_docs'],
  [/\b(orphan(ed)?|decisions?)\b/, 'orphan_decisions'],
];
const ALL_SWEEPS = /\b(all|every|everything|nightly|org|sweeps?|full)\b/;

/** One sweep, null for all of them (the nightly run), or undefined when the words name none. */
export function resolveSweep(target: string): SweepName | null | undefined {
  const t = target.toLowerCase().replace(/[_-]+/g, ' ');
  const named = [...new Set(SWEEP_WORDS.filter(([re]) => re.test(t)).map(([, n]) => n))];
  if (named.length === 1) return named[0];
  if (named.length > 1) return undefined;
  return ALL_SWEEPS.test(t) ? null : undefined;
}

export function sweepTitle(sweep: SweepName | null): string {
  return sweep ? `The ${SWEEP_LABEL[sweep]} sweep` : 'The nightly org sweeps';
}

const STOP = new Set(['the', 'a', 'an', 'bot', 'bots', 'run', 'runs', 'pipeline', 'pipelines', 'runbook', 'dry', 'for', 'of', 'now', 'please', 'my']);
const tokens = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Rows whose name holds every meaningful word the user said (an exact name wins). */
export function matchByName<T>(rows: readonly T[], name: (r: T) => string, said: string): T[] {
  const want = tokens(said).filter((w) => !STOP.has(w));
  const exact = rows.filter((r) => tokens(name(r)).join(' ') === tokens(said).join(' '));
  if (exact.length) return exact;
  if (!want.length) return [];
  return rows.filter((r) => {
    const have = tokens(name(r));
    return want.every((w) => have.some((h) => h === w || (w.length >= 3 && h.startsWith(w))));
  });
}

// ── planner and runner ──────────────────────────────────────────────────────

interface WorkPlan { kind: QueueWorkKind; title: string; sweep?: SweepName | null; botId?: string; definitionId?: string; note?: string; post?: PostSpec; dispatch?: DispatchItem[] }
/** One work item of a dispatch (G22): its title and the drawer's exact body, fixed by the planner. */
interface DispatchItem { id: string; title: string; body: Record<string, unknown> }
interface BotRow { id: string; name: string; enabled?: boolean; pausedReason?: string | null }
interface RunbookRow { id: string; title: string; enabled?: boolean }

/**
 * A V2-9 kind's request, fixed by the planner from the rows its reads
 * returned: the page button's route and body, how its answer names the job,
 * and how the job is followed. The runner sends exactly this; the model's
 * words are in none of it (a target only picks a row).
 */
interface PostSpec {
  url: string;
  body: Record<string, unknown>;
  /** Where the answer carries the id to follow (dotted), or null: the route finished while answering. */
  idAt: string | null;
  follow?: { url: string; reader: JobFollow['reader'] };
  /** The page that shows it; `:id` is the id the answer named. */
  href: string;
  /** A finished answer's one line (the analysis, the review verdict). */
  doneDetail?: (body: Record<string, unknown>) => string | undefined;
  /** A 409 that names a job already doing this (a promoted finding): follow that one instead. */
  existingAt?: string;
}

const KIND_WORDS: Record<string, string> = {
  sweep: 'Sweeps', 'bot-run': 'Bot runs', pipeline: 'Pipeline dry-runs', job: 'Suggested jobs', dispatch: 'Dispatches',
  'finding-promote': 'Findings', 'finding-analyze': 'Findings', 'change-rereview': 'Agent changes', 'change-address': 'Agent changes',
  deck: 'Decks', summarize: 'Summaries', diagram: 'Diagrams', doc: 'Documents', 'assessment-run': 'Scorer runs',
  'draft-evidence': 'Drafts', 'draft-followups': 'Drafts',
};
const KIND_HOME: Record<string, string> = {
  sweep: 'the Work workspace', 'bot-run': 'the Work workspace', pipeline: 'the Pipelines workspace', job: 'the Work workspace', dispatch: 'the Work workspace',
  'finding-promote': 'the Work workspace', 'finding-analyze': 'the Work workspace', 'change-rereview': 'the Work workspace', 'change-address': 'the Work workspace',
  deck: 'another workspace', summarize: 'Work or Social', diagram: 'Work or Social', doc: 'Work or Social',
  'assessment-run': 'the Assessment workspace', 'draft-evidence': 'the Assessment workspace', 'draft-followups': 'the Assessment workspace',
};
const ROLE_REFUSAL: Record<string, string> = {
  sweep: "I can't run the org sweeps with your role.",
  'bot-run': "I can't run bots with your role.",
  pipeline: "I can't start pipeline runs with your role.",
  job: "I can't queue jobs with your role.",
  dispatch: "I can't dispatch work with your role.",
  'finding-promote': "I can't promote findings with your role.",
  'finding-analyze': "I can't analyse findings with your role.",
  'change-rereview': "I can't re-review agent changes with your role.",
  'change-address': "I can't have agent changes addressed with your role.",
  deck: "I can't build decks with your role.",
  summarize: "I can't summarise conversations with your role.",
  diagram: "I can't draw diagrams of conversations with your role.",
  doc: "I can't draft documents from conversations with your role.",
  'assessment-run': "I can't run the scorer with your role.",
  'draft-evidence': "I can't draft for the assessment with your role.",
  'draft-followups': "I can't draft for the assessment with your role.",
};
const SPEND: Record<string, string> = {
  sweep: 'It reads the org graph and refreshes the findings board in the background; it spends nothing.',
  'bot-run': "It starts the bot's run on a computer in the background and spends against the bot's budget.",
  pipeline: 'It queues a governed dry-run on the pipeline queue and spends against its estimate.',
  job: 'An idle computer picks it up and spends against its initiative; it waits for your review.',
  'finding-promote': 'It queues a job for the fleet and spends against its initiative.',
  'finding-analyze': 'An agent reads the document finding and proposes links; it spends a little.',
  'change-rereview': 'A reviewer agent reads the change again and records its verdict; it spends a little.',
  'change-address': 'An agent run addresses the review comments on the change and spends against its initiative.',
  deck: 'An agent builds the deck and spends a little.',
  summarize: 'An agent reads the conversation and spends a little; you choose whether to post the summary.',
  diagram: 'An agent reads the conversation and spends a little; you choose whether to post the diagram.',
  doc: 'An agent reads the conversation and spends a little; you choose where to save the document.',
  'assessment-run': 'The scorer reads the team\'s evidence and spends against the assessment.',
  'draft-evidence': 'An agent drafts the summary for your review and spends a little.',
  'draft-followups': 'An agent drafts follow-ups for your review and spends a little.',
};

const withNote = (detail: string, note: string | undefined) => (note ? `${detail} Note: ${note}` : detail);
const listOf = (names: string[]) => names.slice(0, 5).join(', ');
const planOf = (title: string, detail: string | string[], data: WorkPlan) => ({ plan: { title, detail: Array.isArray(detail) ? detail.join(' ') : detail, data } });
const enc = encodeURIComponent;

/** The models the dispatch drawer offers (lib/devboxModels.ts), by the label a person says. */
function dispatchModel(said: string | undefined, itemModel: unknown): { id: string; label: string } | null {
  if (!said) {
    const own = DEVBOX_MODELS.find((m) => m.id === itemModel) ?? DEVBOX_MODELS.find((m) => m.id === DEFAULT_DEVBOX_MODEL)!;
    return { id: own.id, label: own.label };
  }
  const hit = DEVBOX_MODELS.find((m) => m.label.toLowerCase() === said.trim().toLowerCase().replace(/^claude\s+/, ''));
  return hit ? { id: hit.id, label: hit.label } : null;
}

const usd = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : null);

/** The conversation a command runs on: an initiative's discussion in Work, a Social channel (or team) in Social. */
async function conversationOf(ctx: ToolContext, target: string): Promise<{ channel: string; name: string; href: string } | { result: ToolResult }> {
  if (ctx.tenant === 'orgiq') {
    const found = await findByName(ctx, 'initiative', target);
    if ('result' in found) return found;
    return { channel: `orgiq:initiative:${found.row.id}`, name: found.row.title, href: `/iq/projects/${enc(found.row.id)}` };
  }
  for (const kind of ['channel', 'team'] as const) {
    const read = await readJson<{ match: { id: string; name: string; channel: string } | null; candidates: Array<{ id: string; name: string }> }>(ctx, `/api/social/resolve?${qs({ kind, name: target })}`);
    if (!read.ok) { if (read.status === 404) continue; return { result: readFailure(`the ${kind}`, read.status) }; }
    if (!read.body.match) return { result: ambiguous(`Several ${kind}s match "${target}". Ask which one.`, read.body.candidates.map((c) => ({ name: c.name }))) };
    const m = read.body.match;
    return { channel: m.channel, name: kind === 'team' ? `the ${m.name} team` : `#${m.name}`, href: kind === 'channel' ? `/social/channels/${enc(m.id)}` : '/social/teams' };
  }
  return { result: refused(`There is no channel or team called "${target}" you can read.`) };
}

/** "<dimension> for <team>": the team by the page's own list, the dimension by the team's own read. */
async function dimensionOf(ctx: ToolContext, target: string): Promise<{ teamId: string; team: string; dimId: string; dimension: string } | { result: ToolResult }> {
  const m = /^(.*?)\s+(?:for|of|on)\s+(.+)$/i.exec(target.trim()) ?? /^(.*?)\s*[,/]\s*(.+)$/.exec(target.trim());
  if (!m) return { result: refused('Name the dimension and the team, as "<dimension> for <team>".') };
  const team = await findByName(ctx, 'team', m[2]!);
  if ('result' in team) return team;
  const read = await readJson<{ dimensions?: Array<{ id: string; title: string }> }>(ctx, `/api/assessment/teams/${enc(team.row.id)}`);
  if (!read.ok) return { result: readFailure('that team', read.status) };
  const dims = (read.body.dimensions ?? []).filter((d) => d && typeof d.id === 'string');
  const hits = matchByName(dims, (d) => d.title, m[1]!);
  if (!hits.length) return { result: refused(`${team.row.title} has no dimension called "${m[1]}".`) };
  if (hits.length > 1) return { result: ambiguous(`Several dimensions match "${m[1]}". Ask which one.`, hits.map((d) => ({ name: d.title }))) };
  return { teamId: team.row.id, team: team.row.title, dimId: hits[0]!.id, dimension: hits[0]!.title };
}

/** G55: the deck's focus as the user said it, one line, at most 200 characters; undefined when none. */
function deckFocus(args: VoiceToolArgs): string | undefined {
  const raw = args['focus'];
  if (typeof raw !== 'string') return undefined;
  const words = raw.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return words || undefined;
}

/** The finished deck's one line: the sprint window its brief selected (the route's answer), or the words. */
function deckFocusDetail(body: Record<string, unknown>): string | undefined {
  const brief = body['brief'] && typeof body['brief'] === 'object' ? body['brief'] as Record<string, unknown> : null;
  if (!brief) return undefined;
  const w = brief['window'] && typeof brief['window'] === 'object' ? brief['window'] as Record<string, unknown> : null;
  if (w && typeof w['name'] === 'string') return `focus: ${w['name']} (${String(w['startsOn'] ?? '?')} to ${String(w['endsOn'] ?? '?')})`;
  return typeof brief['words'] === 'string' ? `focus: "${brief['words']}"` : undefined;
}

/** The V2-9 kinds: each resolves its target by the page's own read and fixes the page button's request. */
async function planKind(kind: QueueWorkKind, target: string, args: VoiceToolArgs, ctx: ToolContext, note: string | undefined): Promise<{ plan: ConfirmPlan } | { result: ToolResult }> {
  const data = (title: string, post: PostSpec): WorkPlan => ({ kind, title, post, ...(note ? { note } : {}) });
  switch (kind) {
    case 'job': {
      const read = await readJson<{ suggestions?: Array<{ id: string; title: string; prompt?: string; initiativeName?: string }> }>(ctx, '/api/work/suggestions');
      if (!read.ok) return { result: readFailure('the suggested jobs', read.status) };
      const rows = (read.body.suggestions ?? []).filter((r) => r && typeof r.id === 'string' && typeof r.prompt === 'string');
      const hits = matchByName(rows, (r) => r.title, target);
      if (!hits.length) return { result: refused(`No suggested job matches "${target}".`, { suggestions: rows.slice(0, 10).map((r) => r.title) }) };
      if (hits.length > 1) return { result: ambiguous(`Several suggested jobs match "${target}": ${listOf(hits.map((r) => r.title))}. Which one?`, hits.map((r) => ({ title: r.title, subtitle: r.initiativeName }))) };
      const s = hits[0]!;
      // The suggestion's own prompt, as the queue's Assign button sends it; nothing the model said.
      return planOf(`Queue "${s.title}"`, withNote(SPEND.job!, note), data(`"${s.title}"`, {
        url: '/api/work/jobs', body: { title: s.title, prompt: s.prompt, suggestionId: s.id }, idAt: 'id',
        follow: { url: '/api/work/jobs/:id', reader: 'work-job' }, href: '/iq/work/:id',
      }));
    }
    case 'dispatch': {
      const found = await findByName(ctx, 'work-item', target);
      if ('result' in found) return found;
      // G22: the item's initiative's defaults, as the page's drawer has them, on one card.
      const projectId = typeof found.row.raw['projectId'] === 'string' ? found.row.raw['projectId'] : null;
      if (projectId) return planDispatch(ctx, [{ ref: `work-item:${found.row.id}`, title: found.row.title }], args, note, projectId);
      const item = found.row;
      const model = dispatchModel(typeof args['model'] === 'string' ? args['model'] : undefined, item.raw['estimateModel']);
      if (!model) return { result: refused(`There is no "${String(args['model'])}" model to dispatch with. The models are ${DEVBOX_MODELS.map((m) => m.label).join(', ')}.`) };
      // The drawer's own forecast (GET /api/bots/estimate), read before the card: the card shows the route's figures.
      const points = typeof item.raw['storyPoints'] === 'number' ? item.raw['storyPoints'] : null;
      let forecast = 'No forecast: the work item has no story points.';
      if (points != null) {
        const est = await readJson<{ costUsdP25?: number; costUsdP75?: number }>(ctx, `/api/bots/estimate?${qs({ model: model.id, points })}`);
        if (!est.ok) return { result: readFailure('the forecast', est.status) };
        const lo = usd(est.body.costUsdP25); const hi = usd(est.body.costUsdP75);
        forecast = lo && hi ? `Forecast ${lo} to ${hi}.` : 'The forecast is not known yet.';
      }
      return planOf(`Dispatch "${item.title}" with ${model.label}`, [forecast, withNote('An agent runs it on a computer and spends against the initiative.', note)],
        data(`"${item.title}"`, {
          url: '/api/bots/dispatch-work', body: { workItemId: item.id, model: model.id }, idAt: 'run.jobId',
          follow: { url: '/api/work/jobs/:id', reader: 'work-job' }, href: '/iq/work/:id',
        }));
    }
    case 'finding-promote':
    case 'finding-analyze': {
      const found = await findByName(ctx, 'finding', target, { keep: (r) => !/dismissed|resolved/i.test(r.status ?? '') });
      if ('result' in found) return found;
      const f = found.row;
      const verb = kind === 'finding-promote' ? 'promote' : 'analyze';
      return planOf(kind === 'finding-promote' ? `Turn "${f.title}" into a job` : `Analyse "${f.title}"`, withNote(SPEND[kind]!, note), data(`"${f.title}"`, {
        url: `/api/work/findings/${enc(f.id)}/${verb}`, body: {},
        ...(kind === 'finding-promote'
          ? { idAt: 'id', follow: { url: '/api/work/jobs/:id', reader: 'work-job' as const }, href: '/iq/work/:id', existingAt: 'jobId' }
          : { idAt: null, href: '/iq/work/findings', doneDetail: (b) => {
            const links = Array.isArray(b['links']) ? b['links'].length : 0; const props = Array.isArray(b['proposals']) ? b['proposals'].length : 0;
            return `${links} link${links === 1 ? '' : 's'}, ${props} proposal${props === 1 ? '' : 's'}`;
          } }),
      }));
    }
    case 'change-rereview':
    case 'change-address': {
      // The page offers these where the review asked for changes (re-review also after a failure).
      const allowed = kind === 'change-address' ? /^changes_requested$/ : /^(changes_requested|failed)$/;
      const found = await findByName(ctx, 'change', target, { params: { open: 'true' } });
      if ('result' in found) return found;
      const c = found.row;
      if (!allowed.test(c.status ?? '')) return { result: refused(`"${c.title}" is ${String(c.status ?? 'not open').replace(/_/g, ' ')}; ${kind === 'change-address' ? 'only a change with requested changes is addressed' : 'only a change with requested changes or a failure is re-reviewed'}.`) };
      return planOf(kind === 'change-address' ? `Address the review on "${c.title}"` : `Re-review "${c.title}"`, withNote(SPEND[kind]!, note), data(`"${c.title}"`, kind === 'change-address'
        ? { url: `/api/sdlc/changes/${enc(c.id)}/address`, body: {}, idAt: 'runId', follow: { url: `/api/sdlc/changes/${enc(c.id)}`, reader: 'change' }, href: `/admin/changes/${enc(c.id)}` }
        : { url: `/api/sdlc/changes/${enc(c.id)}/rereview`, body: {}, idAt: null, href: `/admin/changes/${enc(c.id)}`,
          doneDetail: (b) => (typeof b['verdict'] === 'string' ? `Verdict: ${b['verdict']}` : undefined) }));
    }
    case 'deck': {
      // G55: `focus` is the user's words ("progress this past sprint"). Only an initiative's deck takes them: sent as the
      // route's `brief` (with the narrative, which is what they steer), they pick the sprint window and the prose's theme;
      // the slides' figures stay the initiative's record (lib/initiative-deck/brief.ts).
      const focus = deckFocus(args);
      if (ctx.tenant === 'orgiq') {
        const found = await findByName(ctx, 'initiative', target);
        if ('result' in found) return found;
        return planOf(`Build a status deck for ${found.row.title}`, [
          ...(focus ? [`Focus, in your words: "${focus}". The figures stay the initiative's record; the focus picks the period and theme the summary covers.`] : []),
          withNote(SPEND.deck!, note),
        ], data(`The ${found.row.title} deck`, {
          url: `/api/initiative-decks/projects/${enc(found.row.id)}`, body: focus ? { narrative: true, brief: focus } : {}, idAt: null, href: '/iq/decks/:deckId',
          ...(focus ? { doneDetail: deckFocusDetail } : {}),
        }));
      }
      if (focus) return { result: refused('Only an initiative\'s status deck takes a focus; ask again without one, and the deck covers the whole record.', { code: 'focus-not-taken' }) };
      if (ctx.tenant === 'assessment') {
        const found = await findByName(ctx, 'team', target);
        if ('result' in found) return found;
        return planOf(`Build a review deck for ${found.row.title}`, withNote(SPEND.deck!, note), data(`The ${found.row.title} deck`, {
          url: `/api/assessment/teams/${enc(found.row.id)}/decks`, body: {}, idAt: 'runId',
          follow: { url: '/api/assessment/runs/:id', reader: 'assessment-run' }, href: '/assessment/decks/:deckId',
        }));
      }
      if (ctx.tenant === 'pipelines') {
        const found = await findByName(ctx, 'run', target);
        if ('result' in found) return found;
        return planOf(`Build a report deck for ${found.row.title}`, withNote(SPEND.deck!, note), data(`The ${found.row.title} deck`, {
          url: `/api/pipelines/runs/${enc(found.row.id)}/decks`, body: {}, idAt: null, href: '/pipelines/decks/:deckId',
        }));
      }
      const conv = await conversationOf(ctx, target);
      if ('result' in conv) return conv;
      return planOf(`Build a deck from ${conv.name}`, withNote(SPEND.deck!, note), data(`The ${conv.name} deck`, {
        url: '/api/chat/commands/deck/run', body: { channel: conv.channel, text: '' }, idAt: 'runId',
        follow: { url: '/api/chat/commands/deck/runs/:id', reader: 'flow' }, href: conv.href,
      }));
    }
    case 'summarize':
    case 'diagram':
    case 'doc': {
      const conv = await conversationOf(ctx, target);
      if ('result' in conv) return conv;
      const base = ctx.tenant === 'social' ? '/api/chat/commands' : '/api/conversations';
      const what = kind === 'summarize' ? 'Summarise' : kind === 'diagram' ? 'Draw a diagram of' : 'Draft a document from';
      // No text: the command reads the recent conversation, as the composer's bare /summarize does; nothing the model said steers it.
      return planOf(`${what} ${conv.name}`, withNote(SPEND[kind]!, note), data(`${kind === 'summarize' ? 'The summary of' : kind === 'diagram' ? 'The diagram of' : 'The document from'} ${conv.name}`, {
        url: `${base}/${kind}/run`, body: { channel: conv.channel, text: '' }, idAt: 'runId',
        follow: { url: `${base}/${kind}/runs/:id`, reader: 'flow' }, href: conv.href,
      }));
    }
    case 'assessment-run': {
      const found = await findByName(ctx, 'team', target);
      if ('result' in found) return found;
      // Runs' "Score dimensions": the one command that needs nothing but the team (the others take a document the page uploads).
      return planOf(`Run the scorer on ${found.row.title}`, withNote(SPEND['assessment-run']!, note), data(`The ${found.row.title} scorer run`, {
        url: '/api/assessment/runs', body: { command: 'score-dimensions', args: { team: found.row.id }, team_id: found.row.id }, idAt: 'run_id',
        follow: { url: '/api/assessment/runs/:id', reader: 'assessment-run' }, href: '/assessment/runs/:id',
      }));
    }
    case 'draft-evidence':
    case 'draft-followups': {
      const dim = await dimensionOf(ctx, target);
      if ('result' in dim) return dim;
      const which = kind === 'draft-evidence' ? 'evidence-summary' : 'followups';
      const label = kind === 'draft-evidence' ? 'the evidence summary' : 'follow-ups';
      return planOf(`Draft ${label} for ${dim.dimension} (${dim.team})`, withNote(SPEND[kind]!, note), data(`The ${dim.dimension} draft for ${dim.team}`, {
        url: `/api/assessment/teams/${enc(dim.teamId)}/dimensions/${enc(dim.dimId)}/drafts/${which}`, body: {}, idAt: 'runId',
        follow: { url: '/api/assessment/drafts/:id', reader: 'flow' }, href: `/assessment/teams/${enc(dim.teamId)}`,
      }));
    }
    default:
      return { result: refused(`"${kind}" is not something I can queue.`) };
  }
}

/**
 * G22, dispatch without the questionnaire: the items the user named (the
 * page's rows, or one by name) go on one card with the defaults the page's
 * own dispatch drawer derives (prepareJobModel.ts deriveJob): each item's
 * recorded model (else the runtime default; a model only when the user named
 * one), the initiative's codebase, the instruction from the item, no cap; the
 * computer runs under the initiative's own profile, which the server applies.
 * The card names the items, those defaults and the drawer's forecast (GET
 * /api/bots/estimate, summed). Reads only, all of them the page's own: the
 * initiative's work tree, its detail, the codebases.
 */
async function planDispatch(ctx: ToolContext, rows: ReadonlyArray<Pick<PageRow, 'ref' | 'title'>>, args: VoiceToolArgs, note: string | undefined, initiativeId?: string): Promise<{ plan: ConfirmPlan } | { result: ToolResult }> {
  const ids = rows.map((r) => /^work-item:(.+)$/.exec(r.ref)?.[1] ?? null);
  if (ids.some((id) => !id)) return { result: refused('Only work items are dispatched; those rows are not work items.', { code: 'not-on-this-page' }) };
  const record = ctx.page?.()?.record ?? null;
  const projectId = initiativeId ?? (record && /^initiative:(.+)$/.exec(record.ref)?.[1]) ?? null;
  if (!projectId) return { result: refused('Open the initiative whose work this is, then ask again.', { code: 'not-on-this-page' }) };
  const canDispatch = ctx.can('DispatchAgentRun');
  const [tree, detail, codebases] = await Promise.all([
    readJson<WorkItemTree[]>(ctx, `/api/graph/projects/${enc(projectId)}/work`),
    readJson<{ name?: string; repoFullName?: string | null }>(ctx, `/api/graph/projects/${enc(projectId)}`),
    readJson<{ projects?: Codebase[] }>(ctx, '/api/agent-projects'),
  ]);
  if (!tree.ok) return { result: readFailure('the initiative\'s work', tree.status) };
  if (!detail.ok) return { result: readFailure('the initiative', detail.status) };
  const initiative = detail.body.name ?? 'the initiative';
  const all = flattenWorkItems(Array.isArray(tree.body) ? tree.body : []);
  const repos = codebases.ok ? (codebases.body.projects ?? []).filter((c) => c.orgProjectId === projectId) : [];
  const said = typeof args['model'] === 'string' ? args['model'] : undefined;
  const named = said ? dispatchModel(said, null) : null;
  if (said && !named) return { result: refused(`There is no "${said}" model to dispatch with. The models are ${DEVBOX_MODELS.map((m) => m.label).join(', ')}.`) };
  const items: Array<DispatchItem & { model: string; points: number; agentProjectId: string | null }> = [];
  for (const [i, id] of ids.entries()) {
    const item = all.find((w) => w.id === id);
    if (!item) return { result: refused(`"${rows[i]!.title}" is not work of ${initiative} you can dispatch.`) };
    const blocked = dispatchBlockedReason(item, canDispatch);
    if (blocked) return { result: refused(`"${item.title}" cannot be dispatched: ${blocked.toLowerCase()}.`) };
    const job = deriveJob({ item, codebases: repos, linkedRepo: detail.body.repoFullName ?? null });
    if (named) job.model = named.id;
    if (!items.some((x) => x.id === item.id)) items.push({ id: item.id, title: item.title, body: dispatchBody(item.id, job, {}), model: job.model, points: item.storyPoints!, agentProjectId: job.agentProjectId });
  }
  // The drawer's forecast per item, summed: the route's own figures on the card.
  let lo = 0, hi = 0, known = true;
  for (const it of items) {
    const est = await readJson<{ costUsdP25?: number; costUsdP75?: number }>(ctx, `/api/bots/estimate?${qs({ model: it.model, points: it.points, ...(it.agentProjectId ? { agentProjectId: it.agentProjectId } : {}) })}`);
    if (!est.ok) return { result: readFailure('the forecast', est.status) };
    if (typeof est.body.costUsdP25 !== 'number' || typeof est.body.costUsdP75 !== 'number') { known = false; continue; }
    lo += est.body.costUsdP25; hi += est.body.costUsdP75;
  }
  const models = [...new Set(items.map((it) => modelLabel(it.model)))].join(' and ');
  const repo = items[0]!.agentProjectId ? repos.find((c) => c.id === items[0]!.agentProjectId)?.repoFullName ?? null : null;
  const one = items.length === 1;
  const title = one ? `Dispatch "${items[0]!.title}"` : `Dispatch ${items.length} work items`;
  const detailLines = [
    ...items.map((it, i) => `${one ? '' : `${i + 1}. `}${it.title} · ${modelLabel(it.model)}`),
    `Profile: ${initiative}'s own, with ${models}${named ? ' as you asked' : ' (the drawer\'s default)'} and ${repo ? `the ${repo} codebase` : 'the codebase the server picks'}; no per-run cap.`,
    known ? `Forecast ${usd(lo)} to ${usd(hi)}${one ? '' : ' in all'}.` : 'The forecast is not known yet.',
    withNote(`${one ? 'An agent runs it on a computer and spends' : 'Agents run them on computers and spend'} against ${initiative}.`, note),
  ];
  const data: WorkPlan = { kind: 'dispatch', title: one ? `"${items[0]!.title}"` : `${items.length} dispatches`, dispatch: items.map(({ id, title: t, body }) => ({ id, title: t, body })), ...(note ? { note } : {}) };
  return { plan: { title, detail: detailLines, data } };
}

const planQueueWork: VoiceToolPlanner = async (args, ctx) => {
  const kind = String(args['kind']) as QueueWorkKind;
  const kinds = QUEUE_WORK_ACTIONS[ctx.tenant] ?? {};
  // Both checked before any request (the gate is the page button's, so a refusal here matches the page).
  if (!(kind in kinds)) return { result: refused(`${KIND_WORDS[kind] ?? 'That work'} are queued in ${KIND_HOME[kind] ?? 'another workspace'}.`) };
  const action = kinds[kind];
  if (action && !ctx.can(action)) return { result: refused(ROLE_REFUSAL[kind] ?? "I can't queue that with your role.") };
  if (!ctx.jobs) return { result: refused('This dock cannot follow background work right now, so nothing was queued.') };
  let target = String(args['target'] ?? '').trim();
  const note = typeof args['note'] === 'string' && args['note'].trim() ? args['note'].trim() : undefined;

  // G21: the rows of the page in view, by position ("the second one", or `rows`), or a row named among them.
  const rows = Array.isArray(args['rows']) ? (args['rows'] as number[]) : null;
  if (kind === 'deck' && !rows && args['scope'] === 'this-page') {
    // G55: a deck "of this initiative" is the record in view, not one of its rows.
    const record = ctx.page?.()?.record ?? null;
    if (!record || (ctx.tenant === 'orgiq' && !record.ref.startsWith('initiative:'))) {
      return { result: refused('This page shows no initiative to build a deck for; open the initiative, or name it.', { code: 'not-on-this-page' }) };
    }
    target = record.ref;
  } else if (rows || args['scope'] === 'this-page') {
    const picks = rows ?? (/^\d{1,2}$/.test(target) ? [Number(target)] : null);
    const found: PageRow[] = [];
    for (const n of picks ?? []) {
      const hit = pageRowAt(ctx, n);
      if ('result' in hit) return hit;
      if (!found.includes(hit.row)) found.push(hit.row);
    }
    if (!picks) {
      const hit = pageRowNamed(ctx, target);
      if ('result' in hit) return hit;
      found.push(hit.row);
    }
    // G22: a dispatch takes the page's rows as one card, with the page's own defaults.
    if (kind === 'dispatch') return planDispatch(ctx, found, args, note);
    if (found.length > 1) return { result: refused('Only a dispatch takes several rows at once; ask for each in turn.', { code: 'not-on-this-page' }) };
    target = found[0]!.ref;
  }

  if (kind === 'sweep') {
    const sweep = resolveSweep(target);
    if (sweep === undefined) {
      return { result: refused(`There is no "${target}" sweep. The sweeps are bus factor, stale docs and orphan decisions, or all of them.`, { sweeps: ['all', ...Object.values(SWEEP_LABEL)] }) };
    }
    const title = sweepTitle(sweep);
    return { plan: { title: `Run ${title.charAt(0).toLowerCase()}${title.slice(1)} now`, detail: withNote(SPEND.sweep!, note), data: { kind, title, sweep, ...(note ? { note } : {}) } satisfies WorkPlan } };
  }

  if (kind === 'bot-run') {
    const read = await readJson<{ bots?: BotRow[] }>(ctx, '/api/bots');
    if (!read.ok) return { result: readFailure('the bots', read.status) };
    const bots = read.body.bots ?? [];
    const found = matchByName(bots, (b) => b.name, target);
    if (found.length === 0) return { result: refused(`No bot is called "${target}".`, { bots: bots.slice(0, 10).map((b) => b.name) }) };
    if (found.length > 1) return { result: ambiguous(`Several bots match "${target}": ${listOf(found.map((b) => b.name))}. Which one?`, found.map((b) => ({ name: b.name }))) };
    const bot = found[0]!;
    if (bot.enabled === false) return { result: refused(`${bot.name} is paused${bot.pausedReason ? `: ${bot.pausedReason}` : ''}. Resume it on its page first.`) };
    const title = `The ${bot.name} bot`;
    return { plan: { title: `Run the ${bot.name} bot now`, detail: withNote(SPEND['bot-run']!, note), data: { kind, title, botId: bot.id, ...(note ? { note } : {}) } satisfies WorkPlan } };
  }

  if (kind !== 'pipeline') return planKind(kind, target, args, ctx, note);

  const read = await readJson<{ runbooks?: RunbookRow[] }>(ctx, '/api/pipelines/runbooks');
  if (!read.ok) return { result: readFailure('the runbooks', read.status) };
  // A row without a title cannot be named (and must not throw the planner).
  const runbooks = (read.body.runbooks ?? []).filter((r) => r && typeof r.id === 'string' && typeof r.title === 'string');
  const found = matchByName(runbooks, (r) => r.title, target);
  if (found.length === 0) return { result: refused(`No runbook matches "${target}".`, { runbooks: runbooks.slice(0, 10).map((r) => r.title) }) };
  if (found.length > 1) return { result: ambiguous(`Several runbooks match "${target}": ${listOf(found.map((r) => r.title))}. Which one?`, found.map((r) => ({ title: r.title }))) };
  const rb = found[0]!;
  if (rb.enabled === false) return { result: refused(`"${rb.title}" was dismissed from the ladder; reopen it on its page first.`) };
  return { plan: { title: `Dry-run "${rb.title}"`, detail: withNote(SPEND.pipeline!, note), data: { kind, title: `The "${rb.title}" dry-run`, definitionId: rb.id, ...(note ? { note } : {}) } satisfies WorkPlan } };
};

type Posted = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; body: Record<string, unknown> | null };

async function post(ctx: ToolContext, url: string, body: Record<string, unknown>): Promise<Posted> {
  let res: Response;
  try {
    res = await ctx.fetch(url, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return { ok: false, status: 0, body: null };
  }
  const json = await res.json().catch(() => null) as Record<string, unknown> | null;
  return res.ok ? { ok: true, status: res.status, body: json ?? {} } : { ok: false, status: res.status, body: json };
}

/** A route's refusal in words: a money brake names its page, never a confirm the voice cannot give. */
function postRefusal(plan: WorkPlan, posted: Extract<Posted, { ok: false }>, page: string): ToolResult {
  const error = typeof posted.body?.['error'] === 'string' ? posted.body['error'] as string : null;
  // G47: the status as a code, the route's brake by name, and the work's kind (the spoken line names them).
  const gate = typeof posted.body?.['gate'] === 'string' ? { gate: posted.body['gate'] as string } : {};
  const why = { code: posted.status ? `http-${posted.status}` : 'not-connected', ...gate, workKind: plan.kind };
  if (posted.status === 0) return failed('Could not reach the server; nothing was queued.', why);
  if (posted.status === 401 || posted.status === 403) return refused(error && posted.status === 403 && !/^forbidden/i.test(error) ? `Not queued: ${error}.` : ROLE_REFUSAL[plan.kind] ?? "I can't queue that with your role.");
  if (posted.status === 404) return refused(`${plan.title} is gone, or you can no longer reach it; nothing was queued.`);
  if (posted.body?.['confirmFlag'] || posted.status === 402 || posted.status === 409 || posted.status === 423 || posted.status === 429) {
    return refused(`Not queued; it needs ${posted.body?.['confirmFlag'] ? 'a confirm on its page, not by voice' : 'a look on its page'}: ${error ?? `the server answered ${posted.status}`}`, { page, ...why });
  }
  if (posted.status === 400) return refused(`Not queued: ${error ?? 'the server refused it'}.`, { page });
  return failed(`${plan.title} could not be queued (HTTP ${posted.status})${error ? `: ${error}` : ''}.`, why);
}

/** The 409 that names the caller's running background sweep (routes/work.ts), as the job to follow, else null. */
export function runningSweepOf(posted: Posted): QueuedJob | null {
  const b = posted.body;
  if (posted.ok || posted.status !== 409 || !b || b['code'] !== 'sweep-job-running') return null;
  const id = b['jobId'];
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(id)) return null;
  const job = (b['job'] && typeof b['job'] === 'object' ? b['job'] : {}) as Record<string, unknown>;
  const sweep = job['sweep'];
  const title = sweep === null || (typeof sweep === 'string' && sweep in SWEEP_LABEL) ? sweepTitle(sweep as SweepName | null) : 'Your background sweep';
  const href = typeof job['href'] === 'string' && localHref(job['href'] as string) ? job['href'] as string : '/iq/work/findings';
  return { jobId: id, kind: 'sweep', title, href };
}

/** A dotted field of an answer, as an id: letters, digits and the separators server ids use, nothing else. */
function idAt(body: Record<string, unknown> | null, path: string): string | null {
  let v: unknown = body;
  for (const k of path.split('.')) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
  return typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,159}$/.test(v) ? v : null;
}

const fillId = (template: string, id: string) => template.replace(':id', enc(id));

/** A V2-9 kind, confirmed: the page button's request, once, then one toast that follows the job the answer named. */
async function runKind(plan: WorkPlan, ctx: ToolContext, jobs: JobTracking): Promise<ToolResult> {
  const spec = plan.post!;
  return once(ctx, `POST ${spec.url} ${JSON.stringify(spec.body)}`, async () => {
    const posted = await post(ctx, spec.url, spec.body);
    if (!posted.ok) {
      // A finding already promoted names its job: follow that one, nothing new is queued.
      const existing = spec.existingAt && posted.status === 409 ? idAt(posted.body, spec.existingAt) : null;
      if (existing && spec.follow) {
        const job: QueuedJob = { jobId: existing, kind: plan.kind, title: plan.title, href: fillId(spec.href, existing), follow: { url: fillId(spec.follow.url, existing), reader: spec.follow.reader } };
        jobs.track(job);
        return done('work_running', { jobId: existing, workKind: plan.kind, title: plan.title, state: 'running', href: job.href, queued: false,
          next: 'Say it was already under way, so nothing new was queued, and that you will say when it is done.' }, `${plan.title}: already under way`);
      }
      const page = spec.href.includes(':') ? spec.href.split('/:')[0]! : spec.href;
      return postRefusal(plan, posted, page);
    }
    const deckId = idAt(posted.body, 'deckId');
    const href = (id: string | null) => {
      const h = spec.href.replace(':deckId', deckId ? enc(deckId) : '').replace(':id', id ? enc(id) : '');
      return localHref(h) && !h.endsWith('/') ? h : spec.href.split('/:')[0]!;
    };
    if (spec.idAt === null) {
      // The route finished while answering: one settled toast and the notification, no follower.
      const detail = spec.doneDetail?.(posted.body);
      const job: QueuedJob = { jobId: `${plan.kind}-${deckId ?? Date.now().toString(36)}`, kind: plan.kind, title: plan.title, href: href(null), ...(plan.note ? { note: plan.note } : {}) };
      jobs.finished?.(job, 'done', detail);
      return done('work_done', { workKind: plan.kind, title: plan.title, state: 'done', href: job.href, ...(detail ? { detail } : {}),
        next: 'Say it is done, in one short sentence.' }, `${plan.title}: done${detail ? ` (${detail})` : ''}`);
    }
    const id = idAt(posted.body, spec.idAt);
    if (!id || !spec.follow) return failed(`${plan.title} was accepted but the server named no job to follow; check its page.`, { page: href(null), code: 'rejected', workKind: plan.kind });
    const job: QueuedJob = { jobId: id, kind: plan.kind, title: plan.title, href: href(id), follow: { url: fillId(spec.follow.url, id), reader: spec.follow.reader }, ...(plan.note ? { note: plan.note } : {}) };
    jobs.track(job);
    return done('work_queued', { jobId: id, workKind: plan.kind, title: plan.title, state: 'queued', href: job.href,
      next: 'Say it is queued and that you will say when it is done. The portal shows its progress.' }, `${plan.title}: queued`);
  }, () => done('work_queued', { workKind: plan.kind, title: plan.title, alreadyQueued: true }, `${plan.title} was already queued; nothing was sent again`));
}

/**
 * G22: each item through the drawer's own route and body, one after the other,
 * none of the over-budget confirm flags; the first refusal stops the rest and
 * is answered in the usual shape (postRefusal), with what was already sent.
 */
async function runDispatch(plan: WorkPlan, items: readonly DispatchItem[], ctx: ToolContext, jobs: JobTracking): Promise<ToolResult> {
  const queued: Array<{ jobId: string; title: string; href: string }> = [];
  for (const it of items) {
    const itemPlan: WorkPlan = { kind: 'dispatch', title: `"${it.title}"`, ...(plan.note ? { note: plan.note } : {}),
      post: { url: '/api/bots/dispatch-work', body: it.body, idAt: 'run.jobId', follow: { url: '/api/work/jobs/:id', reader: 'work-job' }, href: '/iq/work/:id' } };
    const res = await runKind(itemPlan, ctx, jobs);
    if (res.outcome !== 'done') {
      if (!queued.length) return res;
      return { ...res, output: { ...res.output, dispatched: queued.map((q) => q.title), stoppedAt: it.title } };
    }
    const id = res.output['jobId'];
    if (typeof id === 'string') queued.push({ jobId: id, title: it.title, href: String(res.output['href'] ?? '') });
  }
  if (items.length === 1) return runKindResultOf(queued[0], plan);
  return done('work_queued', {
    workKind: 'dispatch', title: plan.title, state: 'queued', count: queued.length, jobs: queued,
    next: 'Say they are queued and that you will say as each is done. The portal shows their progress.',
  }, `${queued.length} dispatches queued`);
}

function runKindResultOf(q: { jobId: string; title: string; href: string } | undefined, plan: WorkPlan): ToolResult {
  if (!q) return done('work_queued', { workKind: 'dispatch', title: plan.title, alreadyQueued: true }, `${plan.title} was already queued; nothing was sent again`);
  return done('work_queued', { jobId: q.jobId, workKind: 'dispatch', title: `"${q.title}"`, state: 'queued', href: q.href,
    next: 'Say it is queued and that you will say when it is done. The portal shows its progress.' }, `"${q.title}": queued`);
}

const runQueueWork: VoiceToolRunner = async (_args, ctx, planned) => {
  const plan = planned as WorkPlan | undefined;
  if (!plan?.kind) return failed('Nothing was planned to queue.');
  const jobs = ctx.jobs;
  if (!jobs) return refused('This dock cannot follow background work right now, so nothing was queued.');
  if (plan.dispatch) return runDispatch(plan, plan.dispatch, ctx, jobs);
  if (plan.post) return runKind(plan, ctx, jobs);
  let job: QueuedJob | null = null;
  if (plan.kind === 'sweep') {
    const posted = await post(ctx, '/api/work/sweeps/run', { ...(plan.sweep ? { sweep: plan.sweep } : {}), background: true });
    const running = runningSweepOf(posted);
    if (running) {
      // One sweep at a time: follow the one already running (its toast says when it ends); nothing new is queued.
      jobs.track(running);
      return done('work_running', {
        jobId: running.jobId, workKind: 'sweep', title: running.title, state: 'running', href: running.href, queued: false,
        next: 'Say that a sweep they started is still running, so nothing new was queued, and that you will say when it is done.',
      }, `${running.title}: already running`);
    }
    if (!posted.ok) return postRefusal(plan, posted, '/iq/work/findings');
    const id = posted.body['jobId'];
    // The route's own link, only when it stays inside the portal (localHref, as open checks a kept row's).
    const href = typeof posted.body['href'] === 'string' && localHref(posted.body['href'] as string) ? posted.body['href'] as string : '/iq/work/findings';
    if (typeof id === 'string' && id) job = { jobId: id, kind: 'sweep', title: plan.title, href };
  } else if (plan.kind === 'bot-run') {
    const page = `/admin/bots/${encodeURIComponent(plan.botId!)}`;
    const posted = await post(ctx, `/api/bots/${encodeURIComponent(plan.botId!)}/run`, {});
    if (!posted.ok) return postRefusal(plan, posted, page);
    const id = (posted.body['run'] as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' && id) job = { jobId: id, kind: 'bot-run', title: plan.title, href: page, botId: plan.botId! };
  } else {
    const posted = await post(ctx, `/api/pipelines/definitions/${encodeURIComponent(plan.definitionId!)}/dry-run`, {});
    if (!posted.ok) return postRefusal(plan, posted, '/pipelines/runbooks');
    const id = (posted.body['run'] as { id?: unknown } | undefined)?.id;
    if (typeof id === 'string' && id) job = { jobId: id, kind: 'pipeline', title: plan.title, href: `/pipelines/runs/${encodeURIComponent(id)}` };
  }
  if (!job) return failed(`${plan.title} was accepted but the server named no job to follow; check its page.`);
  if (plan.note) job.note = plan.note;
  jobs.track(job);
  return done('work_queued', {
    jobId: job.jobId, workKind: job.kind, title: job.title, state: 'queued', href: job.href,
    next: 'Say it is queued and that you will say when it is done. The portal shows its progress.',
  }, `${job.title}: queued`);
};

export const WORK_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = { queue_work: runQueueWork };
export const WORK_PLANNERS: Readonly<Record<string, VoiceToolPlanner>> = { queue_work: planQueueWork };

// ── the follower ────────────────────────────────────────────────────────────

export type JobState = 'queued' | 'running' | 'done' | 'failed';

/**
 * The library's useToast() keyed job toast (ui-components 2.510.3 `toastJob` / `dismissJobToast`;
 * 2.514.1 `onNavigate`: the link's click comes here default-prevented, so the router takes it).
 */
export interface JobToastSink {
  toastJob(opts: {
    id: string; title: string; state: JobState; detail?: string; href?: string; hrefLabel?: string;
    onNavigate?(href: string): void;
    dismissAfterMs?: number;
    onSettled?(job: { id: string; title: string; state: 'done' | 'failed'; detail?: string; href?: string }): void;
  }): void;
  dismissJobToast(id: string): void;
}

/** What the notification center keeps for a job that ended (lib/localNotifications.ts). */
export interface JobNotice { jobId: string; kind: QueuedJob['kind']; title: string; state: 'done' | 'failed'; detail?: string; href: string }

/** The notification center's entry for an ended job: the bell's `job` kind, in the tenant it was queued in. */
export function jobNotification(n: JobNotice, tenant: string, at: Date): Notification {
  return {
    id: `voice-job:${n.jobId}`, type: 'system', title: `${n.title} ${n.state === 'done' ? 'finished' : 'failed'}`,
    ...(n.detail ? { body: n.detail } : {}), timestamp: at.toISOString(),
    payload: { tenant, kind: 'job', jobId: n.jobId, workKind: n.kind, state: n.state },
    action: { label: 'Open', href: n.href },
  };
}

type Timer = unknown;

export interface JobTrackerOptions {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  toast: JobToastSink;
  /** Mirror an ended job into the notification center (called from the toast's onSettled, once). */
  notify(notice: JobNotice): void;
  /** Say the outcome; the controller speaks only while a session is live. */
  speak(line: string): void;
  /**
   * G35: the router's navigate. The toast's link goes through it (the library's `onNavigate`), so following
   * it never reloads the page and never drops a live voice session.
   */
  navigate?(href: string): void;
  /** VOICE_TOAST_SECONDS from the mint (default DEFAULT_TOAST_SECONDS). */
  toastSeconds(): number;
  /** The stream that says a job may have moved; returns the unsubscribe. */
  wake?(job: QueuedJob, onEvent: () => void): () => void;
  pollMs?: number;
  setTimer?(fn: () => void, ms: number): Timer;
  clearTimer?(t: Timer): void;
}

export const DEFAULT_TOAST_SECONDS = 8;
/** The fallback read when the stream says nothing. */
export const JOB_POLL_MS = 4000;

interface Followed { job: QueuedJob; state: JobState; detail: string | undefined; timer: Timer | null; unwake: (() => void) | null; reading: boolean; again: boolean; settled: boolean }

const PIPELINE_RUNNING = new Set(['running', 'awaiting_approval', 'paused_at_breakpoint']);
const PIPELINE_FAILED = new Set(['failed', 'rejected', 'cancelled', 'stuck']);

const WORK_JOB: Readonly<Record<string, JobState>> = { queued: 'queued', claimed: 'queued', running: 'running', awaiting_review: 'done', done: 'done', failed: 'failed', cancelled: 'failed' };
const FLOW_PHASE: Readonly<Record<string, JobState>> = { received: 'queued', queued: 'queued', running: 'running', completed: 'done', done: 'done', failed: 'failed' };
const CHANGE_STATUS: Readonly<Record<string, JobState>> = { changes_requested: 'running', captured: 'running', in_review: 'running', needs_approval: 'done', approved: 'done', delivered: 'done', failed: 'failed' };
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** A V2-9 job's state from the read its page polls (QueuedJob.follow). */
function followedState(reader: JobFollow['reader'], body: Record<string, unknown>): { state: JobState; detail?: string } | null {
  if (reader === 'work-job') {
    const state = WORK_JOB[String(body['status'])];
    if (!state) return null;
    const result = body['result'] && typeof body['result'] === 'object' ? body['result'] as Record<string, unknown> : {};
    const detail = body['status'] === 'awaiting_review' ? 'Waiting for your review' : state === 'failed' ? text(body['error']) ?? `The job ended ${String(body['status'])}` : state === 'done' ? text(result['summary']) : undefined;
    return { state, ...(detail ? { detail } : {}) };
  }
  if (reader === 'assessment-run') {
    const s = String(body['status']);
    const state: JobState | undefined = s === 'completed' ? 'done' : s === 'failed' ? 'failed' : s === 'running' ? 'running' : undefined;
    return state ? { state, ...(state === 'failed' && text(body['error']) ? { detail: text(body['error']) } : {}) } : null;
  }
  if (reader === 'flow') {
    const state = FLOW_PHASE[String(body['phase'])];
    return state ? { state, ...(state === 'failed' && text(body['error']) ? { detail: text(body['error']) } : {}) } : null;
  }
  const change = body['change'] && typeof body['change'] === 'object' ? body['change'] as Record<string, unknown> : {};
  const state = CHANGE_STATUS[String(change['status'])];
  return state ? { state, ...(state === 'done' ? { detail: `Now ${String(change['status']).replace(/_/g, ' ')}` } : {}) } : null;
}

/** The job's state from the read its page uses, or null when this read says nothing new. */
async function readState(o: JobTrackerOptions, job: QueuedJob): Promise<{ state: JobState; detail?: string } | null> {
  const get = async <T>(url: string): Promise<{ status: number; body: T | null }> => {
    try {
      const res = await o.fetch(url, { credentials: 'include' });
      return { status: res.status, body: res.ok ? await res.json() as T : null };
    } catch { return { status: 0, body: null }; }
  };
  if (job.follow) {
    // Only a URL the planner built from the route's own id, inside the portal's API.
    if (!job.follow.url.startsWith('/api/') || !localHref(job.follow.url)) return null;
    const r = await get<Record<string, unknown>>(job.follow.url);
    if (r.status === 404) return { state: 'failed', detail: 'The server no longer has this; its page shows what ran.' };
    return r.body ? followedState(job.follow.reader, r.body) : null;
  }
  if (job.kind === 'sweep') {
    const r = await get<{ state?: JobState; detail?: string | null }>(`/api/work/sweeps/jobs/${encodeURIComponent(job.jobId)}`);
    if (r.status === 404) return { state: 'failed', detail: 'The server no longer has this job (it restarted); the findings page shows what ran.' };
    if (!r.body?.state) return null;
    return { state: r.body.state, ...(r.body.detail ? { detail: r.body.detail } : {}) };
  }
  if (job.kind === 'pipeline') {
    const r = await get<{ run?: { status?: string; error?: string | null } }>(`/api/pipelines/runs/${encodeURIComponent(job.jobId)}`);
    const status = r.body?.run?.status;
    if (!status) return null;
    if (status === 'completed') return { state: 'done', detail: 'Dry-run completed' };
    if (PIPELINE_FAILED.has(status)) return { state: 'failed', detail: r.body?.run?.error || `The run ended ${status.replace(/_/g, ' ')}` };
    if (PIPELINE_RUNNING.has(status)) return { state: 'running', ...(status === 'awaiting_approval' ? { detail: 'Waiting for an approval' } : {}) };
    return { state: 'queued' };
  }
  const r = await get<{ runs?: Array<{ id: string; status: string; outcome?: Record<string, unknown> | null }> }>(`/api/bots/${encodeURIComponent(job.botId ?? '')}/runs`);
  const run = r.body?.runs?.find((x) => x.id === job.jobId);
  if (!run) return null;
  const reason = typeof run.outcome?.['reason'] === 'string' ? run.outcome['reason'] as string : typeof run.outcome?.['error'] === 'string' ? run.outcome['error'] as string : undefined;
  if (run.status === 'done') return { state: 'done', detail: 'Run finished' };
  if (run.status === 'failed' || run.status === 'skipped') return { state: 'failed', detail: reason ?? `The run ${run.status === 'skipped' ? 'was skipped' : 'failed'}` };
  return { state: 'running' };
}

/** The most of a server's job detail (a run's error, a bot's reason) the voice speaks. */
export const SPOKEN_DETAIL_MAX = 120;

/** What the voice says when a job ends: the server's detail on one line, at most SPOKEN_DETAIL_MAX characters. */
export function outcomeLine(job: Pick<QueuedJob, 'title'>, state: 'done' | 'failed', detail: string | undefined): string {
  let d = (detail ?? '').replace(/\s+/g, ' ').trim();
  if (d.length > SPOKEN_DETAIL_MAX) d = `${d.slice(0, SPOKEN_DETAIL_MAX - 1).trimEnd()}…`;
  d = d.replace(/\.$/, '');
  return `${job.title} ${state === 'done' ? 'finished' : 'failed'}${d ? `: ${d}` : ''}.`;
}

/**
 * Follows queued jobs to the end (see the module header). One per dock; a job
 * keeps its toast and its notification after the voice session ends, and
 * dispose() stops every read.
 */
export class VoiceJobTracker implements JobTracking {
  private readonly followed = new Map<string, Followed>();
  private readonly setTimer: (fn: () => void, ms: number) => Timer;
  private readonly clearTimer: (t: Timer) => void;
  private readonly opts: JobTrackerOptions;

  constructor(opts: JobTrackerOptions) {
    this.opts = opts;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  /** Work the route finished while answering: one toast, already settled (the notification, no spoken line: the result said it). */
  finished(job: QueuedJob, state: 'done' | 'failed', detail?: string): void {
    if (this.followed.has(job.jobId)) return;
    const f: Followed = { job, state, detail: detail ?? (job.note ? `Note: ${job.note}` : undefined), timer: null, unwake: null, reading: false, again: false, settled: false };
    this.followed.set(job.jobId, f);
    this.show(f, false);
  }

  track(job: QueuedJob): void {
    if (this.followed.has(job.jobId)) return;
    const f: Followed = { job, state: 'queued', detail: job.note ? `Note: ${job.note}` : undefined, timer: null, unwake: null, reading: false, again: false, settled: false };
    this.followed.set(job.jobId, f);
    this.show(f);
    f.unwake = this.opts.wake?.(job, () => { void this.read(f); }) ?? null;
    this.schedule(f);
  }

  /** The jobs still being followed (tests, and the pane's unmount). */
  active(): string[] {
    return [...this.followed.values()].filter((f) => !f.settled).map((f) => f.job.jobId);
  }

  dispose(): void {
    for (const f of this.followed.values()) this.stop(f);
    this.followed.clear();
  }

  private schedule(f: Followed): void {
    if (f.settled) return;
    if (f.timer != null) this.clearTimer(f.timer);
    f.timer = this.setTimer(() => { f.timer = null; void this.read(f).then(() => this.schedule(f)); }, this.opts.pollMs ?? JOB_POLL_MS);
  }

  private stop(f: Followed): void {
    if (f.timer != null) this.clearTimer(f.timer);
    f.timer = null;
    f.unwake?.();
    f.unwake = null;
  }

  private async read(f: Followed): Promise<void> {
    if (f.settled) return;
    if (f.reading) { f.again = true; return; }
    f.reading = true;
    try {
      const next = await readState(this.opts, f.job);
      if (next && !f.settled && (next.state !== f.state || next.detail !== f.detail)) {
        // A job never moves backwards on the toast (a stale read after a newer event).
        if (rank(next.state) >= rank(f.state)) {
          f.state = next.state;
          f.detail = next.detail ?? (f.job.note ? `Note: ${f.job.note}` : undefined);
          this.show(f);
        }
      }
    } finally {
      f.reading = false;
    }
    if (f.again && !f.settled) { f.again = false; await this.read(f); }
  }

  private show(f: Followed, speak = true): void {
    const { job } = f;
    const terminal = f.state === 'done' || f.state === 'failed';
    if (terminal) { f.settled = true; this.stop(f); }
    this.opts.toast.toastJob({
      id: job.jobId, title: job.title, state: f.state,
      ...(f.detail ? { detail: f.detail } : {}),
      href: job.href, hrefLabel: 'Open',
      ...(this.opts.navigate ? { onNavigate: (href: string) => this.opts.navigate!(href) } : {}),
      dismissAfterMs: Math.max(1, this.opts.toastSeconds() || DEFAULT_TOAST_SECONDS) * 1000,
      onSettled: (s) => {
        const notice: JobNotice = { jobId: job.jobId, kind: job.kind, title: job.title, state: s.state, href: job.href, ...(s.detail ? { detail: s.detail } : {}) };
        this.opts.notify(notice);
        if (speak) this.opts.speak(outcomeLine(job, s.state, s.detail));
      },
    });
  }
}

const rank = (s: JobState): number => (s === 'queued' ? 0 : s === 'running' ? 1 : 2);
