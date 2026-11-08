// The voice navigator's machine and people tools (docs/voice-navigator-spec.md
// §4, §6, §7; package P4): start_computer, open_shell, run_command,
// send_chat_message, set_status. Each goes through the call the page's own
// control makes, read from the ToolContext the dock fills from the providers
// the shell already mounts (ComputeHost's useCompute, EmbeddedSocial's
// presence, the composer's useChat path): never a second socket, never a new
// endpoint.
//
// The three confirm tools have a planner that runs before the card, with
// reads only: it resolves the initiatives, the computer or the recipient,
// composes the command and mints the delivery id, so the card says exactly
// what will happen and a cancel leaves nothing behind. The runner then acts on
// that plan and nothing else.
//
//   start_computer    initiatives resolved against the user's own list; one
//                     card for the batch with the idle-billing note; one
//                     create({ label, projectId }) per initiative (the lab's
//                     + Computer), a running box reused; a pending toast while
//                     they boot
//   open_shell        the library's openShell (the ⌘K palette's call): opens or
//                     focuses the dock's shell tab; no card
//   run_command       a phrase id from PHRASE_TABLE, never model text; the
//                     composed command checked against GET
//                     /api/devbox/allowlist before the card, so the card never
//                     shows a command the server would refuse; safe mode only,
//                     through the provider's runCommand (the same POST
//                     /api/devbox/:sid/command, allowlist and metacharacter
//                     refusal); the stream lands in the compute dock's output
//                     tab (openOutputTab) and the first lines go back
//   send_chat_message the recipient resolved by GET …/resolve (P6), a read
//                     only; several matches go back to the model as candidates
//                     with no card; a person's DM is opened (POST /api/social/dms)
//                     only on confirm, so a cancel writes nothing (G14);
//                     a clientDeliveryId minted before the card and reused for
//                     the same channel and text, so a retry never double-posts
//   start_call        the team, channel or person resolved by GET …/resolve,
//                     the card says who is rung; confirm runs the shell call
//                     host's own start (useSocialCall: callConversation for a
//                     team or channel, nobody rung; callPeople for a person,
//                     who is rung, after POST /api/social/dms opens the DM at
//                     confirm), once; refused while a call is live
//   set_status        setStatus + updateMetadata({ statusMessage }) on the
//                     tenant's own lobby entry (`<tenant>:lobby`) and, with a
//                     Social grant, the shell's Social entry, which the
//                     presence tooltip reads; no card and no grant (§4, G10:
//                     it changes only the caller)
//
// No React and only `.ts` imports, so `node --test` runs it.

import type { RunCommandPhrase } from './catalogue.ts';
import {
  ambiguous, computersOf, done, failed, qs, readFailure, readJson, refused, socialGrantRefusal, TOOL_RUNNERS,
  type CallAccess, type ConfirmPlan, type DeliveryRecord, type PresenceWriter, type ProjectRow, type ToolContext, type ToolResult,
  type VoiceComputer, type VoiceToolArgs, type VoiceToolPlanner, type VoiceToolRunner,
} from './tools.ts';

/** Lines of command output the model gets (§6 caps every list at 10 rows); the panel keeps the rest. */
export const OUTPUT_LINES_TO_MODEL = 10;
/** Lines the dock's panel keeps per run. */
export const OUTPUT_LINES_KEPT = 400;
/** A run_command that never ends is abandoned after this (the server's own timeout is 120 s). */
export const COMMAND_TIMEOUT_MS = 150_000;
/** How long a delivered message suppresses an identical retry. */
export const DELIVERY_MEMORY_MS = 10 * 60_000;
/** The lab's path: open_computer_lab opens it and start_computer's boxes appear in it. */
export const LAB_PATH = '/admin/devbox';

// ── the phrase table (§6: the model picks the phrase, the dock owns the text) ──

export interface Phrase {
  /** What the card and the strip call it. */
  label: string;
  /** The command, from the phrase's parameters only; null = the parameters do not compose one. */
  compose(params: { since?: string }): string | null;
}

/**
 * `since` as a git date token: only the words and shapes below, so nothing
 * the model says can reach the command line beyond [a-z0-9.-]. "last night"
 * is yesterday and "this morning" today (G9), as tools.ts parseSince reads
 * them.
 */
export function gitSince(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase();
  if (s === 'yesterday' || s === 'last night') return 'yesterday';
  if (s === 'today' || s === 'this morning') return 'midnight';
  if (s === 'last week' || s === 'a week ago') return '1.week.ago';
  const ago = /^(\d{1,3}) (hour|hours|day|days|week|weeks|month|months) ago$/.exec(s);
  if (ago) return `${Number(ago[1])}.${ago[2]!.replace(/s$/, '')}s.ago`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))) return s;
  return null;
}

export const PHRASE_TABLE: Readonly<Record<RunCommandPhrase, Phrase>> = {
  'latest-commits-since-yesterday': { label: 'latest commits since yesterday', compose: () => 'git log --since=yesterday --oneline' },
  'commits-since': { label: 'commits since a date', compose: ({ since }) => { const t = gitSince(since); return t ? `git log --since=${t} --oneline` : null; } },
  status: { label: 'git status', compose: () => 'git status' },
  'diff-stat': { label: 'what changed', compose: () => 'git diff --stat' },
  'list-files': { label: 'the files here', compose: () => 'ls' },
  'working-directory': { label: 'the working directory', compose: () => 'pwd' },
  test: { label: 'the tests', compose: () => 'npm test' },
  'test-python': { label: 'the Python tests', compose: () => 'pytest' },
  lint: { label: 'the linter', compose: () => 'npm run lint' },
  build: { label: 'the build', compose: () => 'npm run build' },
};

/**
 * routes/devbox.ts validateCommand's prefix rule (the middleware catalogue's
 * commandAllowedBy; the drift test holds the two together): a command equal
 * to a trimmed prefix, or starting with one.
 */
export function commandAllowedBy(prefixes: readonly string[], command: string): boolean {
  return prefixes.some((prefix) => command === prefix.trim() || command.startsWith(prefix));
}

/** The safe-mode prefixes this deployment runs (GET /api/devbox/allowlist, the prefixes only). */
export const ALLOWLIST_URL = '/api/devbox/allowlist';

/** The command a phrase composes (exported for the tests and the card). */
export function composeCommand(phrase: string, params: { since?: string }): string | null {
  const p = (PHRASE_TABLE as Record<string, Phrase>)[phrase];
  return p ? p.compose(params) : null;
}

// ── computers ───────────────────────────────────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase();
const computerRow = (c: VoiceComputer) => ({ id: c.id, label: c.label, initiative: c.project, status: c.status });

/** A computer by id, session id, label or (when it has exactly one) its initiative's name. */
export function findComputer(computers: readonly VoiceComputer[], ref: string): { computer: VoiceComputer } | { candidates: VoiceComputer[] } {
  const q = norm(ref);
  const boxes = computers.filter((c) => c.kind !== 'local');
  const exact = boxes.find((c) => c.id === ref || c.sessionId === ref) ?? boxes.find((c) => norm(c.label) === q);
  if (exact) return { computer: exact };
  const byProject = boxes.filter((c) => c.project && norm(c.project) === q);
  if (byProject.length === 1) return { computer: byProject[0]! };
  const loose = byProject.length ? byProject : boxes.filter((c) => norm(c.label).includes(q) || (c.project && norm(c.project).includes(q)));
  if (loose.length === 1) return { computer: loose[0]! };
  return { candidates: loose.length ? loose : boxes };
}

function noComputer(ref: string, candidates: VoiceComputer[]): ToolResult {
  if (!candidates.length) return refused('You have no computers in the Computer Lab. start_computer starts one.');
  return ambiguous(`No single computer matches "${ref}". Ask which one.`, candidates.map(computerRow));
}

function computeOrRefusal(ctx: ToolContext): { compute: NonNullable<ToolContext['compute']> } | { result: ToolResult } {
  if (ctx.tenant !== 'orgiq') return { result: refused('Computers are in the Work workspace.') };
  if (!ctx.compute) return { result: refused('The Computer Lab is not available to this session.') };
  return { compute: ctx.compute };
}

// ── start_computer ──────────────────────────────────────────────────────────

interface StartPlan { start: Array<{ id: string; name: string }>; reuse: Array<{ id: string; name: string; computer: VoiceComputer }> }

/** A box that is up or coming up; a stopped or failed one is not reused. */
const reusable = (c: VoiceComputer) => c.status !== 'stopped' && c.status !== 'error';

/** The initiatives named, by id or by name, against the user's own list (the same read as list_active_initiatives). */
export function resolveInitiatives(list: readonly ProjectRow[], refs: readonly string[]): { found: ProjectRow[]; missing: string[] } {
  const found: ProjectRow[] = [];
  const missing: string[] = [];
  for (const ref of refs) {
    const q = norm(ref);
    const hit = list.find((p) => p.id === ref) ?? list.find((p) => norm(p.name) === q)
      ?? (() => { const loose = list.filter((p) => norm(p.name).includes(q)); return loose.length === 1 ? loose[0] : undefined; })();
    if (hit) { if (!found.some((f) => f.id === hit.id)) found.push(hit); } else missing.push(ref);
  }
  return { found, missing };
}

const listNames = (names: string[]) => (names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
export const IDLE_BILLING_NOTE = 'A running computer bills idle time until it stops.';

const planStartComputer: VoiceToolPlanner = async (args, ctx) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c;
  if (!c.compute.canManage) return { result: refused("I can't start computers with your role.") };
  const refs = [...new Set((args['initiativeIds'] as string[]).map((r) => r.trim()).filter(Boolean))];
  if (!refs.length) return { result: refused('Name at least one initiative.') };
  const read = await readJson<ProjectRow[]>(ctx, `/api/graph/projects?${qs({ scope: 'mine', limit: 50 })}`);
  if (!read.ok) return { result: readFailure('your initiatives', read.status) };
  const list = Array.isArray(read.body) ? read.body : [];
  const { found, missing } = resolveInitiatives(list, refs);
  if (missing.length) {
    return { result: ambiguous(`I could not find ${listNames(missing.map((m) => `"${m}"`))} among your initiatives. Ask which.`,
      list.slice(0, 10).map((p) => ({ id: p.id, name: p.name }))) };
  }
  const computers = c.compute.computers();
  const plan: StartPlan = { start: [], reuse: [] };
  for (const p of found) {
    const box = computersOf(computers, p.id).find(reusable);
    if (box) plan.reuse.push({ id: p.id, name: p.name, computer: box });
    else plan.start.push({ id: p.id, name: p.name });
  }
  // Nothing to start, nothing to bill: answered at once, no card.
  if (!plan.start.length) return { result: startResult([], plan.reuse) };
  const n = plan.start.length;
  const reusedLine = plan.reuse.length ? ` ${listNames(plan.reuse.map((r) => r.name))} already ${plan.reuse.length === 1 ? 'has' : 'have'} one.` : '';
  const card: ConfirmPlan = {
    title: n === 1 ? `Start a computer for ${plan.start[0]!.name}` : `Start ${n} computers`,
    detail: `${n === 1 ? '' : `For ${listNames(plan.start.map((s) => s.name))}.`}${reusedLine} ${IDLE_BILLING_NOTE}`.trim(),
    data: plan,
  };
  return { plan: card };
};

type Started = { initiativeId: string; initiative: string; computerId?: string; label?: string; state: string; reused?: boolean; error?: string };

function startResult(started: Started[], reuse: StartPlan['reuse']): ToolResult {
  const rows: Started[] = [
    ...started,
    ...reuse.map((r) => ({ initiativeId: r.id, initiative: r.name, computerId: r.computer.id, label: r.computer.label, state: r.computer.status ?? 'unknown', reused: true })),
  ];
  const ok = rows.filter((r) => !r.error);
  const bad = rows.filter((r) => r.error);
  const summary = [
    started.filter((r) => !r.error).length ? `Started ${started.filter((r) => !r.error).length}` : '',
    reuse.length ? `${reuse.length} already running` : '',
    bad.length ? `${bad.length} failed` : '',
  ].filter(Boolean).join('; ') || 'Nothing started';
  const outcome = ok.length ? 'done' : 'failed';
  const res = outcome === 'done'
    ? done('computers', { count: ok.length, rows, lab: LAB_PATH, note: started.length ? 'New computers take a minute or two to boot; they show in the Computer Lab.' : undefined }, summary)
    : failed(summary, { rows });
  return res;
}

const runStartComputer: VoiceToolRunner = async (_args, ctx, planned) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c.result;
  const plan = planned as StartPlan | undefined;
  if (!plan) return refused('start_computer runs only after the user confirms its card.');
  const names = plan.start.map((s) => s.name);
  const toast = ctx.toast?.pending(names.length === 1 ? `Starting a computer for ${names[0]}` : `Starting ${names.length} computers`, listNames(names));
  const started: Started[] = [];
  for (const p of plan.start) {
    try {
      const box = await c.compute.create({ label: p.name.slice(0, 40), projectId: p.id });
      started.push({ initiativeId: p.id, initiative: p.name, computerId: box.id, label: box.label, state: box.status ?? 'provisioning' });
    } catch (err) {
      started.push({ initiativeId: p.id, initiative: p.name, state: 'failed', error: (err as Error)?.message ?? 'refused' });
    }
  }
  const res = startResult(started, plan.reuse);
  if (toast) {
    if (res.outcome === 'done') ctx.toast!.success(toast, res.summary, 'They show in the Computer Lab as they boot.');
    else ctx.toast!.error(toast, 'Computers did not start', started.map((s) => s.error).filter(Boolean).join('; '));
  }
  return res;
};

// ── open_shell ──────────────────────────────────────────────────────────────

const runOpenShell: VoiceToolRunner = async (args, ctx) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c.result;
  const ref = String(args['computerId']);
  const found = findComputer(c.compute.computers(), ref);
  if ('candidates' in found) return noComputer(ref, found.candidates);
  const box = found.computer;
  const cwd = typeof args['cwd'] === 'string' && args['cwd'].trim() ? args['cwd'].trim() : box.workspace;
  const opened = c.compute.openShell({ id: box.id, label: box.label, sessionId: box.sessionId, ...(cwd ? { cwd } : {}) });
  if (!opened.ok) return refused('Every shell tab is in use. Ask the user to close one first.', { limit: 'at-capacity' });
  return done('shell_opened', { computerId: box.id, label: box.label, ...(cwd ? { cwd } : {}) }, `Shell on ${box.label}`);
};

// ── run_command ─────────────────────────────────────────────────────────────

interface CommandPlan { computer: VoiceComputer; command: string; phrase: string; cwd?: string }

const planRunCommand: VoiceToolPlanner = async (args, ctx) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c;
  const phrase = String(args['phrase']);
  const command = composeCommand(phrase, { since: typeof args['since'] === 'string' ? args['since'] : undefined });
  if (!command) {
    return { result: refused(phrase === 'commits-since'
      ? `I could not read "${String(args['since'] ?? '')}" as a date. Say yesterday, last night, this morning, "3 hours ago", "3 days ago", "last week" or a date.`
      : `There is no "${phrase}" command. For anything else, ask the user to open the shell and type it.`) };
  }
  const ref = String(args['computerId']);
  const found = findComputer(c.compute.computers(), ref);
  if ('candidates' in found) return { result: noComputer(ref, found.candidates) };
  const box = found.computer;
  // The server's own allowlist, read before the card (G9): the mint already left out the phrases it
  // refuses, and this catches the composed text (a `since` token, an allowlist changed since the mint).
  const allow = await readJson<{ prefixes?: unknown }>(ctx, ALLOWLIST_URL);
  if (!allow.ok) {
    return { result: allow.status === 401 || allow.status === 403 ? refused("I can't run commands on machines with your role.") : readFailure('the command allowlist', allow.status) };
  }
  const prefixes = Array.isArray(allow.body.prefixes) ? allow.body.prefixes.filter((p): p is string => typeof p === 'string') : [];
  if (!commandAllowedBy(prefixes, command)) {
    return { result: refused(`This deployment's safe mode does not run "${command}". Ask the user to open the shell on ${box.label} and type it.`, { computerId: box.id, command }) };
  }
  const plan: CommandPlan = { computer: box, command, phrase, ...(box.workspace ? { cwd: box.workspace } : {}) };
  return { plan: { title: `Run on ${box.label}`, detail: command, data: plan } };
};

/** One SSE frame of the command stream into lines (stdout/stderr), the exit code and an error. */
function absorb(ev: Record<string, unknown>, out: { lines: string[]; partial: string; exitCode: number | null; error?: string }): void {
  const push = (text: string, prefix = '') => {
    const all = (out.partial + text).split('\n');
    out.partial = all.pop() ?? '';
    for (const l of all) if (out.lines.length < OUTPUT_LINES_KEPT) out.lines.push(prefix + l);
  };
  if (ev['type'] === 'stdout' && typeof ev['text'] === 'string') push(ev['text']);
  else if (ev['type'] === 'stderr' && typeof ev['text'] === 'string') push(ev['text']);
  else if (ev['type'] === 'exit') out.exitCode = typeof ev['exitCode'] === 'number' ? ev['exitCode'] : null;
  else if (ev['type'] === 'devbox_error') out.error = typeof ev['error'] === 'string' ? ev['error'] : 'the computer reported an error';
}

const runRunCommand: VoiceToolRunner = async (_args, ctx, planned) => {
  const c = computeOrRefusal(ctx);
  if ('result' in c) return c.result;
  const plan = planned as CommandPlan | undefined;
  if (!plan) return refused('run_command runs only after the user confirms its card.');
  const { computer, command } = plan;
  const out = { lines: [] as string[], partial: '', exitCode: null as number | null, error: undefined as string | undefined };
  // One output tab per computer and phrase: a re-run replaces its lines in place (openOutputTab's id rule).
  const tab = `voice-${computer.id}-${plan.phrase}`;
  let tabRefused = false;
  const view = (running: boolean) => {
    const shown = ctx.showOutput?.({
      id: tab, computerId: computer.id, computer: computer.label, command, lines: [...out.lines, ...(out.partial ? [out.partial] : [])],
      running, exitCode: out.exitCode, ...(out.error ? { error: out.error } : {}),
    });
    if (shown === false) tabRefused = true;
  };
  view(true);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), COMMAND_TIMEOUT_MS);
  try {
    // Safe mode, always: the dock never sends `full` (§4, §6). The server's allowlist and metacharacter refusal stay the backstop.
    await c.compute.runCommand(computer.sessionId, { command, mode: 'safe', ...(plan.cwd ? { cwd: plan.cwd } : {}) },
      (ev) => { absorb(ev, out); view(true); }, abort.signal);
  } catch (err) {
    const message = (err as Error)?.message ?? 'refused';
    out.error = message;
    view(false);
    // A 400 from the allowlist reads "not an allowlisted read-only command — switch to full shell…".
    if (/allowlist|metacharacter|not allowed/i.test(message)) {
      return refused(`${computer.label} refused "${command}" in safe mode. Ask the user to open the shell and type it.`, { computerId: computer.id, command, server: message });
    }
    return failed(abort.signal.aborted ? `"${command}" on ${computer.label} did not finish in time.` : `"${command}" on ${computer.label} failed: ${message}`,
      { computerId: computer.id, command });
  } finally {
    clearTimeout(timer);
  }
  if (out.partial) { out.lines.push(out.partial); out.partial = ''; }
  view(false);
  const lines = out.lines.filter((l) => l.trim());
  const body = {
    computerId: computer.id, computer: computer.label, command, exitCode: out.exitCode,
    totalLines: lines.length, lines: lines.slice(0, OUTPUT_LINES_TO_MODEL), truncated: lines.length > OUTPUT_LINES_TO_MODEL,
    ...(out.error ? { error: out.error } : {}),
    ...(tabRefused ? { outputTab: 'Every tab in the compute dock is in use, so the full output is not shown; ask the user to close one.' } : {}),
  };
  if (out.error) return failed(`"${command}" on ${computer.label}: ${out.error}`, body);
  const summary = `${command} on ${computer.label}: ${lines.length ? `${lines.length} line${lines.length === 1 ? '' : 's'}` : 'no output'}${out.exitCode ? `, exit ${out.exitCode}` : ''}`;
  return done('command_output', body, summary);
};

// ── send_chat_message ───────────────────────────────────────────────────────

interface ResolveBody {
  kind: 'team' | 'channel' | 'person';
  match: { id: string; name: string; channelId: string; channel: string } | null;
  candidates: Array<{ id: string; name: string }>;
}

interface PostPlan { channel: string; name: string; kind: ResolveBody['kind']; text: string; deliveryId: string; key: string; userId?: string }

/** The DM button's own call (routes/social.ts POST /dms): writes the pair's membership, at confirm only (G14). */
export const OPEN_DM_URL = '/api/social/dms';

/**
 * Opens the caller's DM with `userId` now that the user confirmed: the
 * resolver only named it, so a cancelled or ambiguous card left nothing
 * behind. Null when it is open and is the channel the card showed; else the
 * result that ends the call with nothing sent or rung.
 */
async function openDm(ctx: ToolContext, userId: string, channel: string, fallback: string): Promise<ToolResult | null> {
  let res: Response;
  try {
    res = await ctx.fetch(OPEN_DM_URL, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }) });
  } catch {
    return failed('Could not reach the server to open the conversation; nothing was sent.');
  }
  if (res.status === 401 || res.status === 403) return socialGrantRefusal(ctx, fallback);
  if (!res.ok) return failed(`The conversation could not be opened (HTTP ${res.status}); nothing was sent.`);
  const body = await res.json().catch(() => null) as { channel?: unknown } | null;
  if (body?.channel !== channel) return failed('The conversation that opened is not the one on the card; nothing was sent.');
  return null;
}

const deliveryKey = (channel: string, text: string) => `${channel}\u0000${text}`;

function newDeliveryId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `vd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The id for this channel and text: reused while one is remembered, minted otherwise (before the card). */
export function deliveryFor(book: Map<string, DeliveryRecord>, channel: string, text: string, now: number): DeliveryRecord {
  const key = deliveryKey(channel, text);
  const known = book.get(key);
  if (known && (known.state !== 'sent' || now - known.at < DELIVERY_MEMORY_MS)) return known;
  const fresh: DeliveryRecord = { deliveryId: newDeliveryId(), state: 'pending', at: now };
  book.set(key, fresh);
  return fresh;
}

const where = (kind: ResolveBody['kind'], name: string) => (kind === 'person' ? name : kind === 'team' ? `the ${name} team` : `#${name}`);

const planSendChat: VoiceToolPlanner = async (args, ctx) => {
  const social = ctx.social;
  if (!social) return { result: socialGrantRefusal(ctx, 'Messages go through Social, which this session cannot reach.') };
  if (social.unavailable) return { result: refused(social.unavailable) };
  const target = args['target'] as { kind: 'team' | 'channel' | 'dm'; name: string };
  const text = String(args['text']);
  const kind = target.kind === 'dm' ? 'person' : target.kind;
  let res: Response;
  try {
    res = await ctx.fetch(`${social.api}/resolve?${qs({ kind, name: target.name })}`, { credentials: 'include' });
  } catch {
    return { result: failed('Could not reach the server to find the recipient.') };
  }
  if (res.status === 404) return { result: refused(`There is no ${kind} called "${target.name}" you can post to.`) };
  if (!res.ok) return { result: readFailure('the recipient', res.status) };
  const body = await res.json() as ResolveBody;
  if (!body.match) {
    return { result: ambiguous(`Several ${kind === 'person' ? 'people' : `${kind}s`} match "${target.name}". Ask which one; nothing was sent.`,
      body.candidates.map((c) => ({ id: c.id, name: c.name }))) };
  }
  const now = ctx.now().getTime();
  const record = deliveryFor(social.deliveries, body.match.channel, text, now);
  const label = where(kind, body.match.name);
  if (record.state === 'sent') {
    return { result: done('posted', { to: label, posted: true, alreadyPosted: true },
      `Already posted to ${label}; nothing was sent again`) };
  }
  // A person's DM is only named here; the runner opens it on confirm (G14), so the plan keeps the peer's id.
  const plan: PostPlan = { channel: body.match.channel, name: body.match.name, kind, text, deliveryId: record.deliveryId, key: deliveryKey(body.match.channel, text),
    ...(kind === 'person' ? { userId: body.match.id } : {}) };
  // The card shows the channel and the text verbatim (§6): the message is sent exactly as shown.
  return { plan: { title: kind === 'person' ? `Message ${body.match.name}` : `Post to ${label}`, detail: text, data: plan } };
};

const runSendChat: VoiceToolRunner = async (_args, ctx, planned) => {
  const social = ctx.social;
  const plan = planned as PostPlan | undefined;
  if (!plan) return refused('send_chat_message sends only after the user confirms its card.');
  if (!social) return socialGrantRefusal(ctx, 'Messages go through Social, which this session cannot reach.');
  const label = where(plan.kind, plan.name);
  const record = social.deliveries.get(plan.key) ?? { deliveryId: plan.deliveryId, state: 'pending' as const, at: ctx.now().getTime() };
  if (record.state === 'sent') return done('posted', { to: label, posted: true, alreadyPosted: true }, `Already posted to ${label}`);
  if (plan.kind === 'person') {
    if (!plan.userId) return refused('send_chat_message sends to a person only after the user confirms its card.');
    const blocked = await openDm(ctx, plan.userId, plan.channel, "I can't message people with your role.");
    if (blocked) return blocked;
  }
  social.deliveries.set(plan.key, { ...record, state: 'pending' });
  try {
    await social.send({ channel: plan.channel, text: plan.text, deliveryId: plan.deliveryId });
  } catch (err) {
    social.deliveries.set(plan.key, { ...record, state: 'failed', at: ctx.now().getTime() });
    return failed(`The message to ${label} was not confirmed: ${(err as Error)?.message ?? 'no receipt'}. A retry reuses the same delivery, so it cannot post twice.`);
  }
  social.deliveries.set(plan.key, { ...record, state: 'sent', at: ctx.now().getTime() });
  return done('posted', { to: label, posted: true }, `Posted to ${label}`);
};

// ── start_call ──────────────────────────────────────────────────────────────

interface CallPlan { kind: ResolveBody['kind']; name: string; channel: string; userId?: string; title: string }

/** The call host start_call may use, or why it cannot go ahead (before the card and again at confirm). */
function callRefusal(ctx: ToolContext): { calls: CallAccess } | { result: ToolResult } {
  if (!ctx.social) return { result: socialGrantRefusal(ctx, 'Calls go through Social, which this session cannot reach.') };
  if (!ctx.calls) return { result: refused('Calls are not available on this page.') };
  if (ctx.calls.unavailable) return { result: refused(ctx.calls.unavailable) };
  const active = ctx.calls.active();
  if (active) return { result: refused(`You are already in a call (${active.title}). Leave it first.`) };
  return { calls: ctx.calls };
}

const planStartCall: VoiceToolPlanner = async (args, ctx) => {
  const gate = callRefusal(ctx);
  if ('result' in gate) return gate;
  const social = ctx.social!;
  const target = args['target'] as { kind: 'team' | 'channel' | 'dm'; name: string };
  const kind = target.kind === 'dm' ? 'person' : target.kind;
  const read = await readJson<ResolveBody>(ctx, `${social.api}/resolve?${qs({ kind, name: target.name })}`);
  if (!read.ok) {
    if (read.status === 404) return { result: refused(`There is no ${kind} called "${target.name}" you can call.`) };
    return { result: readFailure(kind === 'person' ? 'the person' : `the ${kind}`, read.status) };
  }
  const body = read.body;
  if (!body.match) {
    return { result: ambiguous(`Several ${kind === 'person' ? 'people' : `${kind}s`} match "${target.name}". Ask which one; no call was started.`,
      body.candidates.map((c) => ({ id: c.id, name: c.name }))) };
  }
  const m = body.match;
  const plan: CallPlan = kind === 'person'
    ? { kind, name: m.name, channel: m.channel, userId: m.id, title: m.name }
    // A channel is named by its slug (the resolver's id), as the Social page's own call names it (`#<slug>`).
    : { kind, name: m.name, channel: m.channel, title: kind === 'team' ? `${m.name} team` : `#${m.id}` };
  // Who the call reaches is the card (§6): a person is rung; a team or channel huddle rings nobody.
  return { plan: kind === 'person'
    ? { title: `Call ${m.name}`, detail: `This rings ${m.name}.`, data: plan }
    : { title: `Start a huddle in ${kind === 'team' ? `the ${m.name} team` : plan.title}`, detail: 'Nobody is rung; anyone who opens it sees the huddle and can join.', data: plan } };
};

const runStartCall: VoiceToolRunner = async (_args, ctx, planned) => {
  const plan = planned as CallPlan | undefined;
  if (!plan) return refused('start_call starts only after the user confirms its card.');
  // Checked again at confirm time: a call may have started while the card was up.
  const gate = callRefusal(ctx);
  if ('result' in gate) return gate.result;
  if (plan.kind === 'person') {
    // The DM lobby's membership is written now, not when the name was resolved (G14): the gateway admits the call by it.
    const blocked = await openDm(ctx, plan.userId!, plan.channel, "I can't start calls with your role.");
    if (blocked) return blocked;
    // The DM opened while the card was up: a call may have started meanwhile.
    const again = callRefusal(ctx);
    if ('result' in again) return again.result;
    again.calls.callPeople([{ userId: plan.userId!, displayName: plan.name }]);
  } else gate.calls.callConversation({ channel: plan.channel, title: plan.title });
  return plan.kind === 'person'
    ? done('call_started', { with: plan.name, rung: true }, `Calling ${plan.name}`)
    : done('call_started', { in: plan.title, rung: false }, `Huddle starting in ${plan.title}`);
};

// ── set_status ──────────────────────────────────────────────────────────────

const runSetStatus: VoiceToolRunner = async (args, ctx) => {
  // G10: the tenant's own presence entry first (the lobby the shell announces on; no grant, it changes only the
  // caller), then the Social one as a second write when the session holds Social. Either alone is enough.
  const lobby = ctx.presence?.lobby() ?? null;
  const writes: Array<{ on: string; writer: PresenceWriter }> = [
    ...(lobby ? [{ on: 'workspace', writer: lobby }] : []),
    ...(ctx.social?.presence ? [{ on: 'Social', writer: ctx.social.presence }] : []),
  ];
  if (!writes.length) return refused('Your presence is not connected right now. Try again in a moment.');
  const status = String(args['status']);
  const message = typeof args['message'] === 'string' ? args['message'].trim() : undefined;
  for (const { writer } of writes) {
    writer.setStatus(status);
    // Only the dictated message (§10): an omitted one leaves the current message as it is.
    if (message !== undefined) writer.updateMetadata({ statusMessage: message || null });
  }
  return done('status_set', { status, ...(message ? { message } : {}), on: writes.map((w) => w.on) },
    message ? `Status: ${status}, "${message}"` : `Status: ${status}`);
};

// ── the tables ──────────────────────────────────────────────────────────────

export const ACTION_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = {
  start_computer: runStartComputer,
  open_shell: runOpenShell,
  run_command: runRunCommand,
  send_chat_message: runSendChat,
  start_call: runStartCall,
  set_status: runSetStatus,
};

/** Every catalogue tool's runner: the reads (tools.ts) and the actions. */
export const VOICE_RUNNERS: Readonly<Record<string, VoiceToolRunner>> = { ...TOOL_RUNNERS, ...ACTION_RUNNERS };

/** The planners that run before a confirm card. */
export const VOICE_PLANNERS: Readonly<Record<string, VoiceToolPlanner>> = {
  start_computer: planStartComputer,
  run_command: planRunCommand,
  send_chat_message: planSendChat,
  start_call: planStartCall,
};

export type { VoiceToolArgs };
