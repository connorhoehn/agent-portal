// The machine and people tools (docs/voice-navigator-spec.md §4, §6, §10; P4):
// gates without a request, the phrase table, the confirmed paths, and the
// result caps. Tool-level here; the card, confirm and cancel through the
// controller are in controller.test.ts.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALLOWLIST_URL, commandAllowedBy, composeCommand, deliveryFor, gitSince, IDLE_BILLING_NOTE, OUTPUT_LINES_TO_MODEL, PHRASE_TABLE, VOICE_PLANNERS, VOICE_RUNNERS,
} from '../actions.ts';
import { RUN_COMMAND_PHRASES } from '../catalogue.ts';
import {
  MAX_FIELD_CHARS, MAX_ROWS, needsConfirm, planPreparedCall, prepareToolCall, ResultMemory, runPreparedCall,
  type CallAccess, type CommandEvent, type CommandOutputView, type ComputeAccess, type DeliveryRecord, type SocialAccess, type ToolResult, type VoiceComputer,
} from '../tools.ts';
import { presenceAvatarUsers } from '../../../pages/assessment/knowledge/knowledgeFormat.ts';
import { fakeFetch, route, toolContext } from './voiceHarness.ts';

const SID = (c: string) => c.repeat(40);
/** The middleware's default safe-mode allowlist, read from routes/devbox.ts itself. */
const DEVBOX_SOURCE = readFileSync(new URL('../../../../../middleware/src/routes/devbox.ts', import.meta.url), 'utf8');
const DEFAULT_PREFIXES = [...(/const DEFAULT_ALLOWLIST = \[([^\]]*)\]/.exec(DEVBOX_SOURCE)![1]!.matchAll(/'([^']+)'/g))].map((m) => m[1]!);
/** GET /api/devbox/allowlist answering these prefixes (the default allowlist unless told otherwise). */
const allowlist = (prefixes: readonly string[] = DEFAULT_PREFIXES) => fakeFetch([route('GET', ALLOWLIST_URL, 200, { prefixes })]);
const BOXES: VoiceComputer[] = [
  { id: 'c-alpha', label: 'alpha-1', sessionId: SID('a'), status: 'running', projectId: 'p1', project: 'Alpha', workspace: '/mnt/workspace/alpha' },
  { id: 'c-beta', label: 'beta-1', sessionId: SID('b'), status: 'stopped', projectId: 'p2', project: 'Beta' },
  { id: 'c-laptop', label: 'my laptop', sessionId: SID('l'), status: 'idle', kind: 'local' },
];

interface FakeCompute extends ComputeAccess { created: Array<{ label?: string; projectId?: string }>; shells: unknown[]; commands: Array<{ sessionId: string; body: unknown }>; removed: string[] }
function fakeCompute(opts: { canManage?: boolean; stream?: CommandEvent[]; fail?: string; computers?: VoiceComputer[]; removeFails?: string } = {}): FakeCompute {
  const created: FakeCompute['created'] = [];
  const removed: string[] = [];
  const shells: unknown[] = [];
  const commands: FakeCompute['commands'] = [];
  return {
    created, shells, commands, removed,
    canManage: opts.canManage ?? true,
    remove: async (id) => { if (opts.removeFails) throw new Error(opts.removeFails); removed.push(id); },
    computers: () => opts.computers ?? BOXES,
    create: async (input) => { created.push(input); return { id: `new-${created.length}`, label: input.label ?? 'computer', sessionId: SID(String(created.length)), status: 'provisioning', ...(input.projectId ? { projectId: input.projectId } : {}) }; },
    openShell: (box) => { shells.push(box); return { ok: true, id: box.id }; },
    runCommand: async (sessionId, body, onEvent) => {
      commands.push({ sessionId, body });
      if (opts.fail) throw new Error(opts.fail);
      for (const ev of opts.stream ?? []) onEvent(ev);
    },
  };
}

interface FakeSocial extends SocialAccess { sends: Array<Parameters<SocialAccess['send']>[0]>; status: unknown[]; meta: unknown[] }
function fakeSocial(opts: { failSends?: number; presence?: boolean; api?: string } = {}): FakeSocial {
  const sends: FakeSocial['sends'] = [];
  const status: unknown[] = [];
  const meta: unknown[] = [];
  let failures = opts.failSends ?? 0;
  return {
    sends, status, meta,
    api: opts.api ?? '/api/social/plane',
    unavailable: null,
    send: async (input) => { sends.push(input); if (failures > 0) { failures--; throw new Error('The message receipt was not confirmed.'); } },
    presence: opts.presence === false ? null : { setStatus: (s) => { status.push(s); }, updateMetadata: (m) => { meta.push(m); } },
    deliveries: new Map<string, DeliveryRecord>(),
  };
}

/** What the controller does: prepare, plan (the card), then run with the plan once confirmed. */
async function confirmAndRun(name: string, args: unknown, ctx: ReturnType<typeof toolContext>): Promise<{ card: { title: string; detail?: string | string[] } | null; result: ToolResult }> {
  const prepared = prepareToolCall(name, args, ctx);
  if (!prepared.ok) return { card: null, result: prepared.result };
  const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
  if (planned && 'result' in planned) return { card: null, result: planned.result };
  const card = planned ? { title: planned.plan.title, ...(planned.plan.detail ? { detail: planned.plan.detail } : {}) } : null;
  return { card, result: await runPreparedCall(prepared.call, ctx, VOICE_RUNNERS, planned?.plan.data) };
}

const P4_REFUSALS: Array<{ tool: string; args: Record<string, unknown>; deny: string[] }> = [
  { tool: 'computer', args: { action: 'start', initiatives: ['p1'] }, deny: ['ManageDevbox'] },
  { tool: 'computer', args: { action: 'open-shell', computer: 'c-alpha' }, deny: ['OpenDevboxShell'] },
  { tool: 'computer', args: { action: 'run', computer: 'c-alpha', phrase: 'status' }, deny: ['OpenDevboxShell'] },
  { tool: 'computer', args: { action: 'stop', computer: 'c-alpha' }, deny: ['ManageDevbox'] },
  { tool: 'computer', args: { action: 'hand-work', machine: 'laptop', job: 'login' }, deny: ['ConnectLocalCompute'] },
  { tool: 'message', args: { target: { kind: 'team', name: 'platform' }, text: 'out today' }, deny: ['PostMessage'] },
  { tool: 'call', args: { action: 'start', target: { kind: 'team', name: 'platform' } }, deny: ['StartCall'] },
];

test('every P4 tool refuses on its gate without a network call, a machine call or a post', async () => {
  for (const { tool, args, deny } of P4_REFUSALS) {
    let calls = 0;
    const compute = fakeCompute();
    const social = fakeSocial();
    const c = toolContext({ deny: deny as never[], compute, social, fetch: async () => { calls++; throw new Error('network'); } });
    const { result } = await confirmAndRun(tool, args, c);
    assert.equal(result.outcome, 'refused', tool);
    assert.equal(calls, 0, `${tool} made no request`);
    assert.deepEqual([compute.created, compute.shells, compute.commands, compute.removed, social.sends], [[], [], [], [], []], tool);
  }
  // §6: the refusal is said the way the button's own gate would.
  const r = prepareToolCall('computer', { action: 'run', computer: 'c', phrase: 'status' }, toolContext({ deny: ['OpenDevboxShell'] }));
  assert.ok(!r.ok && /can't run commands on machines with your role/.test(String(r.result.output['reason'])));
  // set_status has no Cedar action of its own: without the shell's presence entry it refuses, still with no request.
  const s = await confirmAndRun('set_status', { status: 'away' }, toolContext({ social: fakeSocial({ presence: false }) }));
  assert.equal(s.result.outcome, 'refused');
});

// ── run_command ──

test('the phrase table composes every command; latest-commits-since-yesterday is git log --since=yesterday --oneline', () => {
  assert.deepEqual(Object.keys(PHRASE_TABLE).sort(), [...RUN_COMMAND_PHRASES].sort());
  const table = Object.fromEntries(RUN_COMMAND_PHRASES.map((p) => [p, composeCommand(p, { since: '3 days ago' })]));
  assert.deepEqual(table, {
    'latest-commits-since-yesterday': 'git log --since=yesterday --oneline',
    'commits-since': 'git log --since=3.days.ago --oneline',
    status: 'git status',
    'diff-stat': 'git diff --stat',
    'list-files': 'ls',
    'working-directory': 'pwd',
    test: 'npm test',
    'test-python': 'pytest',
    lint: 'npm run lint',
    build: 'npm run build',
  });
  // The middleware's safe-mode backstop (routes/devbox.ts): no metacharacter ever, and every read-only phrase is on its default allowlist.
  const meta = new RegExp(/const SHELL_META = \/(.*)\/;/.exec(DEVBOX_SOURCE)![1]!);
  for (const [phrase, command] of Object.entries(table)) {
    assert.doesNotMatch(command!, meta, phrase);
    assert.equal(commandAllowedBy(DEFAULT_PREFIXES, command!), !['test', 'lint', 'build'].includes(phrase), `${phrase} on the default allowlist`);
  }
});

test('since is read into git date words only; anything else composes nothing', () => {
  assert.equal(gitSince('yesterday'), 'yesterday');
  assert.equal(gitSince('Today'), 'midnight');
  assert.equal(gitSince('last week'), '1.week.ago');
  assert.equal(gitSince('2 hours ago'), '2.hours.ago');
  assert.equal(gitSince('2026-11-01'), '2026-11-01');
  // G9: "last night" is yesterday, "this morning" today.
  assert.equal(gitSince('Last night'), 'yesterday');
  assert.equal(gitSince('this morning'), 'midnight');
  assert.equal(composeCommand('commits-since', { since: 'last night' }), 'git log --since=yesterday --oneline');
  for (const bad of ['yesterday; rm -rf /', '$(whoami)', '1 day ago && ls', '`id`', 'tomorrow', '', undefined]) {
    assert.equal(gitSince(bad), null, String(bad));
    assert.equal(composeCommand('commits-since', { since: bad }), null);
  }
});

test('run_command: a model-supplied command is ignored, the phrase runs in safe mode, and the result says so', async () => {
  const compute = fakeCompute({ stream: [{ type: 'stdout', text: 'On branch main\n' }, { type: 'exit', exitCode: 0 }] });
  const c = toolContext({ compute, fetch: allowlist().fetch });
  const { card, result } = await confirmAndRun('computer', { action: 'run', computer: 'alpha-1', phrase: 'status', command: 'rm -rf /' }, c);
  assert.deepEqual(card, { title: 'Run on alpha-1', detail: 'git status' });
  assert.deepEqual(compute.commands, [{ sessionId: SID('a'), body: { command: 'git status', mode: 'safe', cwd: '/mnt/workspace/alpha' } }]);
  assert.equal(result.outcome, 'done');
  assert.deepEqual((result.output['ignored'] as { fields: string[] }).fields, ['command']);
  assert.doesNotMatch(JSON.stringify(result.output), /rm -rf/);
  // A command with no phrase is refused outright: nothing composes it, nothing runs.
  const bare = await confirmAndRun('computer', { action: 'run', computer: 'alpha-1', command: 'git log --since=yesterday' }, toolContext({ compute: fakeCompute() }));
  assert.equal(bare.result.outcome, 'refused');
  assert.match(String(bare.result.output['reason']), /phrase table/);
});

test('run_command captures the stream into the output panel and gives the model the first lines, capped', async () => {
  const lines = Array.from({ length: 30 }, (_, i) => `${String(i).padStart(7, '0')} commit ${'x'.repeat(200)}`);
  const text = `${lines.join('\n')}\n`;
  // Chunks split mid-line, as a stream does.
  const stream: CommandEvent[] = [{ type: 'stdout', text: text.slice(0, 333) }, { type: 'stdout', text: text.slice(333, 2001) }, { type: 'stdout', text: text.slice(2001) }, { type: 'exit', exitCode: 0 }];
  const compute = fakeCompute({ stream });
  const views: CommandOutputView[] = [];
  const { result } = await confirmAndRun('computer', { action: 'run', computer: 'c-alpha', phrase: 'latest-commits-since-yesterday' }, toolContext({ compute, fetch: allowlist().fetch, showOutput: (v) => { views.push(v); } }));
  assert.equal((compute.commands[0]!.body as { command: string }).command, 'git log --since=yesterday --oneline');
  assert.equal(result.output['totalLines'], 30);
  assert.equal((result.output['lines'] as string[]).length, OUTPUT_LINES_TO_MODEL);
  assert.equal(result.output['truncated'], true);
  for (const l of result.output['lines'] as string[]) assert.ok(l.length <= MAX_FIELD_CHARS);
  const last = views.at(-1)!;
  assert.deepEqual([last.running, last.lines.length, last.exitCode, last.computer], [false, 30, 0, 'alpha-1'], 'the panel keeps every line');
  assert.ok(views[0]!.running, 'the panel opens while it runs');
  assert.ok(views.every((v) => v.id === 'voice-c-alpha-latest-commits-since-yesterday'), 'one output tab per computer and phrase');
  assert.equal(result.output['outputTab'], undefined);
});

test('run_command: an output tab the dock cannot open (every tab in use) is said in the result, and the lines still go back', async () => {
  const compute = fakeCompute({ stream: [{ type: 'stdout', text: 'a\nb\n' }, { type: 'exit', exitCode: 0 }] });
  const { result } = await confirmAndRun('computer', { action: 'run', computer: 'c-alpha', phrase: 'status' }, toolContext({ compute, fetch: allowlist().fetch, showOutput: () => false }));
  assert.equal(result.outcome, 'done');
  assert.deepEqual(result.output['lines'], ['a', 'b']);
  assert.match(String(result.output['outputTab']), /in use/);
});

test('run_command: the card never shows a command the server\'s allowlist refuses; the planner reads the allowlist and refuses offline', async () => {
  // The default allowlist has no npm: test, lint and build end before the card, and nothing is sent.
  for (const phrase of ['test', 'lint', 'build']) {
    const compute = fakeCompute();
    const f = allowlist();
    const { card, result } = await confirmAndRun('computer', { action: 'run', computer: 'c-alpha', phrase }, toolContext({ compute, fetch: f.fetch }));
    assert.equal(card, null, phrase);
    assert.equal(result.outcome, 'refused');
    assert.match(String(result.output['reason']), /safe mode does not run .*open the shell/);
    assert.deepEqual(compute.commands, []);
    assert.deepEqual(f.log.map((r) => r.url), [ALLOWLIST_URL], 'one read, the allowlist');
  }
  // Opted in with npm test: test gets its card, lint still does not.
  const opted = [...DEFAULT_PREFIXES, 'npm test'];
  assert.deepEqual((await confirmAndRun('computer', { action: 'run', computer: 'c-alpha', phrase: 'test' }, toolContext({ compute: fakeCompute(), fetch: allowlist(opted).fetch }))).card,
    { title: 'Run on alpha-1', detail: 'npm test' });
  assert.equal((await confirmAndRun('computer', { action: 'run', computer: 'c-alpha', phrase: 'lint' }, toolContext({ compute: fakeCompute(), fetch: allowlist(opted).fetch }))).card, null);
  // A since token the allowlist's prefix does not cover is caught on the composed text, not the phrase.
  const narrow = await confirmAndRun('computer', { action: 'run', computer: 'c-alpha', phrase: 'commits-since', since: '3 days ago' }, toolContext({ compute: fakeCompute(), fetch: allowlist(['git log --since=yesterday']).fetch }));
  assert.equal(narrow.card, null);
  assert.equal(narrow.result.outcome, 'refused');
  // No read of the allowlist (403) is the role refusal, never a card.
  const denied = await confirmAndRun('computer', { action: 'run', computer: 'c-alpha', phrase: 'status' }, toolContext({ compute: fakeCompute(), fetch: fakeFetch([route('GET', ALLOWLIST_URL, 403, { error: 'Forbidden' })]).fetch }));
  assert.equal(denied.card, null);
  assert.match(String(denied.result.output['reason']), /can't run commands/);
});

test('run_command: the server refusing a phrase in safe mode is still a refusal that says to open the shell', async () => {
  // The allowlist read admitted it (opted in), the server's own check refused it anyway (the backstop).
  const compute = fakeCompute({ fail: 'not an allowlisted read-only command — switch to full shell to run it' });
  const { result } = await confirmAndRun('computer', { action: 'run', computer: 'c-alpha', phrase: 'build' }, toolContext({ compute, fetch: allowlist([...DEFAULT_PREFIXES, 'npm run build']).fetch }));
  assert.equal(result.outcome, 'refused');
  assert.match(String(result.output['reason']), /open the shell and type it/);
  assert.equal((compute.commands[0]!.body as { mode: string }).mode, 'safe');
});

test('run_command and open_shell: an unknown or ambiguous computer goes back as candidates; a laptop is never a target', async () => {
  const { result } = await confirmAndRun('computer', { action: 'run', computer: 'gamma', phrase: 'status' }, toolContext({ compute: fakeCompute() }));
  assert.equal(result.output['kind'], 'ambiguous');
  assert.deepEqual((result.output['candidates'] as Array<{ id: string }>).map((c) => c.id), ['c-alpha', 'c-beta']);
  const laptop = await confirmAndRun('computer', { action: 'open-shell', computer: 'c-laptop' }, toolContext({ compute: fakeCompute() }));
  assert.equal(laptop.result.output['kind'], 'ambiguous');
});

// ── open_shell ──

test('open_shell opens (or focuses) the lab\'s shell tab with no card, by label or initiative name', async () => {
  const compute = fakeCompute();
  const { card, result } = await confirmAndRun('computer', { action: 'open-shell', computer: 'Alpha' }, toolContext({ compute }));
  assert.equal(card, null);
  assert.equal(result.outcome, 'done');
  assert.deepEqual(compute.shells, [{ id: 'c-alpha', label: 'alpha-1', sessionId: SID('a'), cwd: '/mnt/workspace/alpha' }]);
  const full = fakeCompute();
  full.openShell = () => ({ ok: false, reason: 'at-capacity' });
  assert.equal((await confirmAndRun('computer', { action: 'open-shell', computer: 'c-alpha' }, toolContext({ compute: full }))).result.outcome, 'refused');
});

test('open_shell takes no directory from the model: a `cwd` argument is refused before any shell opens, and the shell starts in the box\'s workspace (sweep 2 M3)', async () => {
  const compute = fakeCompute();
  for (const cwd of ['/etc', '../../root', 'src; rm -rf ~', 'x'.repeat(500)]) {
    const { result } = await confirmAndRun('computer', { action: 'open-shell', computer: 'Alpha', cwd }, toolContext({ compute }));
    assert.equal(result.outcome, 'refused', cwd);
    assert.match(String(result.output['error'] ?? result.summary), /cwd is not an argument/, cwd);
  }
  assert.deepEqual(compute.shells, [], 'nothing opened');
  const { result } = await confirmAndRun('computer', { action: 'open-shell', computer: 'Alpha' }, toolContext({ compute }));
  assert.equal(result.output['cwd'], '/mnt/workspace/alpha');
  assert.deepEqual(compute.shells, [{ id: 'c-alpha', label: 'alpha-1', sessionId: SID('a'), cwd: '/mnt/workspace/alpha' }]);
});

// ── start_computer ──

const PROJECTS = [
  { id: 'p1', name: 'Alpha', status: 'active' }, { id: 'p2', name: 'Beta', status: 'active' }, { id: 'p3', name: 'Gamma rollout', status: 'active' },
];

test('start_computer: the card lists every initiative with the idle-billing note; nothing starts before the run; one create each', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/graph/projects', 200, PROJECTS)]);
  const compute = fakeCompute();
  const toasts: string[] = [];
  const ctx = toolContext({ fetch, compute, toast: { pending: (t) => { toasts.push(`pending:${t}`); return 't1'; }, success: (_i, t) => { toasts.push(`success:${t}`); }, error: (_i, t) => { toasts.push(`error:${t}`); } } });
  const prepared = prepareToolCall('computer', { action: 'start', initiatives: ['p1', 'Beta', 'gamma'] }, ctx);
  assert.ok(prepared.ok);
  const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
  assert.ok(planned && 'plan' in planned);
  assert.equal(log[0]!.url, '/api/graph/projects?scope=mine&limit=50');
  assert.equal(planned.plan.title, 'Start 2 computers');
  assert.equal(planned.plan.detail, `For Beta and Gamma rollout. Alpha already has one. ${IDLE_BILLING_NOTE}`);
  assert.deepEqual(compute.created, [], 'planning starts nothing');
  const result = await runPreparedCall(prepared.call, ctx, VOICE_RUNNERS, planned.plan.data);
  assert.deepEqual(compute.created, [{ label: 'Beta', projectId: 'p2' }, { label: 'Gamma rollout', projectId: 'p3' }], 'the stopped Beta box is not reused');
  assert.equal(result.outcome, 'done');
  const rows = result.output['rows'] as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((r) => [r['initiative'], r['computerId'], r['state'], r['reused'] ?? false]),
    [['Beta', 'new-1', 'provisioning', false], ['Gamma rollout', 'new-2', 'provisioning', false], ['Alpha', 'c-alpha', 'running', true]]);
  assert.equal(result.output['lab'], '/admin/devbox', 'the boxes appear where open_computer_lab goes');
  assert.deepEqual(toasts, ['pending:Starting 2 computers', 'success:Started 2; 1 already running']);
});

test('start_computer: an initiative it cannot find goes back with the user\'s list; all running answers with no card', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/graph/projects', 200, PROJECTS)]);
  const missing = await confirmAndRun('computer', { action: 'start', initiatives: ['Delta'] }, toolContext({ fetch, compute: fakeCompute() }));
  assert.equal(missing.result.output['kind'], 'ambiguous');
  assert.equal((missing.result.output['candidates'] as unknown[]).length, 3);
  const compute = fakeCompute();
  const running = await confirmAndRun('computer', { action: 'start', initiatives: ['Alpha'] }, toolContext({ fetch, compute }));
  assert.equal(running.card, null);
  assert.equal(running.result.outcome, 'done');
  assert.deepEqual(compute.created, []);
  assert.equal((await confirmAndRun('computer', { action: 'start', initiatives: ['p1'] }, toolContext({ fetch, compute: fakeCompute({ canManage: false }) }))).result.outcome, 'refused');
});

// ── computer (V2-8): one tool, five actions; stop and hand-work ──

test('computer: open-shell needs no card; every other action does, and each is gated on its own button\'s action', () => {
  const ctx = toolContext({ allow: ['ManageDevbox', 'OpenDevboxShell'] });
  const card = (args: Record<string, unknown>) => { const p = prepareToolCall('computer', args, ctx); assert.ok(p.ok); return needsConfirm(p.call); };
  assert.equal(card({ action: 'open-shell', computer: 'alpha-1' }), false);
  for (const action of ['start', 'stop', 'run']) assert.equal(card({ action, computer: 'alpha-1', initiatives: ['p1'], phrase: 'status' }), true, action);
  // hand-work is ConnectLocalCompute: refused here before any request, said the way Local compute's own gate would.
  const r = prepareToolCall('computer', { action: 'hand-work', machine: 'laptop', job: 'login' }, ctx);
  assert.ok(!r.ok && /can't hand work to machines with your role/.test(String(r.result.output['reason'])));
});

test('computer start: a retry of the same confirmed card starts nothing new (the action ledger)', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/graph/projects', 200, PROJECTS)]);
  const compute = fakeCompute();
  const ctx = toolContext({ fetch, compute });
  const first = await confirmAndRun('computer', { action: 'start', initiatives: ['Beta'] }, ctx);
  assert.equal(first.result.outcome, 'done');
  const again = await confirmAndRun('computer', { action: 'start', initiatives: ['Beta'] }, ctx);
  assert.equal(again.result.output['alreadyStarted'], true);
  assert.deepEqual(compute.created, [{ label: 'Beta', projectId: 'p2' }], 'one box');
});

const FLEET = { boxes: [
  { id: 'c-alpha', label: 'alpha-1', sessionId: SID('a'), status: 'running', projectId: 'p1', ownerId: 'u-me' },
  { id: 'c-beta', label: 'beta-1', sessionId: SID('b'), status: 'running', projectId: 'p2', ownerId: 'u-colleague' },
] };

test('computer stop: only the caller\'s own box, from the lab\'s own read; the card says it ends billing; a second stop is already stopped', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/devbox/boxes', 200, FLEET)]);
  const compute = fakeCompute();
  const ctx = toolContext({ fetch, compute });
  const { card, result } = await confirmAndRun('computer', { action: 'stop', computer: 'Alpha' }, ctx);
  assert.deepEqual(card, { title: 'Stop alpha-1', detail: 'It stops the computer and its billing; the workspace stays until it expires.' });
  assert.deepEqual(compute.removed, ['c-alpha']);
  assert.equal(result.summary, 'Stopped alpha-1');
  assert.deepEqual(log.map((l) => `${l.method} ${l.url}`), ['GET /api/devbox/boxes'], 'the remove is the lab\'s own call, nothing else');
  // A box a colleague started on an initiative the caller can see: named back, never stopped.
  const theirs = await confirmAndRun('computer', { action: 'stop', computer: 'beta-1' }, toolContext({ fetch, compute }));
  assert.equal(theirs.card, null);
  assert.match(String(theirs.result.output['reason']), /started by someone else/);
  assert.deepEqual(compute.removed, ['c-alpha']);
  // The route answering "not found" to a retry is the outcome asked for.
  const gone = await confirmAndRun('computer', { action: 'stop', computer: 'alpha-1' }, toolContext({ fetch, compute: fakeCompute({ removeFails: 'computer not found' }) }));
  assert.equal(gone.result.outcome, 'done');
  assert.equal(gone.result.output['alreadyStopped'], true);
  // No session id: nothing is stopped, nothing is read.
  const anon = await confirmAndRun('computer', { action: 'stop', computer: 'alpha-1' }, toolContext({ fetch, compute, userId: null }));
  assert.equal(anon.result.outcome, 'refused');
});

const NODES = { nodes: [{ id: 'n-1', label: 'my-macbook', acceptJobs: true, jobKinds: ['local:task'] }, { id: 'n-2', label: 'old-thinkpad', acceptJobs: false }] };
const SUGGESTIONS = { suggestions: [{ workItemId: 'w-login', title: 'Fix the login redirect', initiativeName: 'Alpha' }, { workItemId: 'w-docs', title: 'Update the onboarding docs', initiativeName: 'Alpha' }] };

test('computer hand-work: the user\'s own machine and an item from the page\'s pick list; the page\'s body on confirm, once', async () => {
  const { fetch, log } = fakeFetch([
    route('GET', '/api/local-compute/nodes', 200, NODES), route('GET', '/api/work/suggestions', 200, SUGGESTIONS),
    route('GET', '/api/bots', 200, { bots: [{ id: 'b-1', name: 'Docs bot', enabled: true }] }),
    route('POST', '/api/local-compute/nodes/n-1/work', 201, { id: 'job-77', status: 'queued' }),
  ]);
  const ctx = toolContext({ fetch, allow: ['ConnectLocalCompute'] });
  const { card, result } = await confirmAndRun('computer', { action: 'hand-work', machine: 'macbook', job: 'login redirect' }, ctx);
  assert.deepEqual(card, { title: 'Hand "Fix the login redirect" to my-macbook', detail: 'Your machine runs the work item with its own login; a run that changes a repo waits for your review.' });
  assert.equal(result.outcome, 'done');
  assert.equal(result.output['href'], '/iq/local-compute?machine=n-1');
  const posts = log.filter((l) => l.method === 'POST');
  assert.deepEqual(posts.map((p) => [p.url, p.body]), [['/api/local-compute/nodes/n-1/work', { workItemId: 'w-login', requiresReview: true }]]);
  assert.ok(!log.some((l) => l.url === '/api/bots'), 'bots are offered only with ManageBots');
  // The same request again: the ledger answers, nothing is posted twice.
  const again = await confirmAndRun('computer', { action: 'hand-work', machine: 'macbook', job: 'login redirect' }, ctx);
  assert.equal(again.result.output['alreadyHanded'], true);
  assert.equal(log.filter((l) => l.method === 'POST').length, 1);
});

test('computer hand-work: a machine not accepting jobs, an unknown job and the route\'s 409 are refusals; a bot needs ManageBots', async () => {
  const routes = [route('GET', '/api/local-compute/nodes', 200, NODES), route('GET', '/api/work/suggestions', 200, SUGGESTIONS),
    route('GET', '/api/bots', 200, { bots: [{ id: 'b-1', name: 'Docs bot', enabled: true }, { id: 'b-2', name: 'Parked bot', enabled: true, pausedReason: 'over budget' }] })];
  const off = await confirmAndRun('computer', { action: 'hand-work', machine: 'thinkpad', job: 'login' }, toolContext({ fetch: fakeFetch(routes).fetch }));
  assert.equal(off.card, null);
  assert.match(String(off.result.output['reason']), /not accepting jobs/);
  const unknown = await confirmAndRun('computer', { action: 'hand-work', machine: 'macbook', job: 'payroll' }, toolContext({ fetch: fakeFetch(routes).fetch }));
  assert.equal(unknown.result.outcome, 'refused');
  const bot = fakeFetch([...routes, route('POST', '/api/local-compute/nodes/n-1/work', 201, { id: 'job-8' })]);
  const withBots = await confirmAndRun('computer', { action: 'hand-work', machine: 'macbook', job: 'docs bot' }, toolContext({ fetch: bot.fetch, allow: ['ConnectLocalCompute', 'ManageBots'] }));
  assert.equal(withBots.result.outcome, 'done');
  assert.deepEqual(bot.log.filter((l) => l.method === 'POST').map((l) => l.body), [{ botId: 'b-1', requiresReview: true }]);
  const parked = await confirmAndRun('computer', { action: 'hand-work', machine: 'macbook', job: 'parked bot' }, toolContext({ fetch: fakeFetch(routes).fetch, allow: ['ConnectLocalCompute', 'ManageBots'] }));
  assert.equal(parked.result.outcome, 'refused', 'a paused bot is not on the pick list');
  const busy = await confirmAndRun('computer', { action: 'hand-work', machine: 'macbook', job: 'onboarding' },
    toolContext({ fetch: fakeFetch([...routes, route('POST', '/api/local-compute/nodes/n-1/work', 409, { gate: 'kinds', error: 'this machine runs local:task — it has not registered for devbox:task' })]).fetch }));
  assert.equal(busy.result.outcome, 'refused');
  assert.match(String(busy.result.output['reason']), /my-macbook did not take it/);
});

// ── call (G7, V2-12) ──

interface FakeCalls extends CallAccess { conversations: Array<{ channel: string; title: string }>; people: Array<Array<{ userId: string; displayName: string }>>; live: { title: string } | null }
function fakeCalls(opts: { live?: { title: string } | null; unavailable?: string | null } = {}): FakeCalls {
  const f: FakeCalls = {
    conversations: [], people: [], live: opts.live ?? null,
    unavailable: opts.unavailable ?? null,
    active: () => f.live,
    callConversation: (c) => { f.conversations.push(c); f.live = { title: c.title }; },
    callPeople: (p) => { f.people.push(p); f.live = { title: p.map((x) => x.displayName).join(', ') }; },
  };
  return f;
}
const TEAM = { kind: 'team', match: { id: 't1', name: 'Platform', channelId: 'r1', channel: 'social:team:platform:general' }, candidates: [{ id: 't1', name: 'Platform' }] };
const ADA = { kind: 'person', match: { id: 'u-ada', name: 'Ada Lovelace', channelId: 'social:dm:u-ada:u-me', channel: 'social:dm:u-ada:u-me' }, candidates: [{ id: 'u-ada', name: 'Ada Lovelace' }] };

test('call start: a team resolves through /resolve, the card says nobody is rung, and confirm starts one huddle in its channel', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, TEAM)]);
  const calls = fakeCalls();
  const { card, result } = await confirmAndRun('call', { action: 'start', target: { kind: 'team', name: 'platform' } }, toolContext({ fetch, social: fakeSocial(), calls }));
  assert.deepEqual(log.map((r) => r.url), ['/api/social/plane/resolve?kind=team&name=platform']);
  assert.deepEqual(card, { title: 'Start a huddle in the Platform team', detail: 'Nobody is rung; anyone who opens it sees the huddle and can join.' });
  assert.equal(result.outcome, 'done');
  assert.deepEqual(calls.conversations, [{ channel: 'social:team:platform:general', title: 'Platform team' }]);
  assert.deepEqual(calls.people, []);
});

test('call start: a person is a DM call that rings them, and the card says so; the DM is opened at confirm (G14)', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/social/resolve', 200, ADA), route('POST', '/api/social/dms', 200, { channel: ADA.match.channel, peers: [] })]);
  const calls = fakeCalls();
  const { card, result } = await confirmAndRun('call', { action: 'start', target: { kind: 'dm', name: 'Ada' } }, toolContext({ tenant: 'social', fetch, social: fakeSocial({ api: '/api/social' }), calls }));
  assert.equal(log[0]!.url, '/api/social/resolve?kind=person&name=Ada');
  assert.deepEqual(log.slice(1).map((r) => [r.method, r.url, r.body]), [['POST', '/api/social/dms', { userId: 'u-ada' }]]);
  assert.deepEqual(card, { title: 'Call Ada Lovelace', detail: 'This rings Ada Lovelace.' });
  assert.equal(result.outcome, 'done');
  assert.deepEqual(calls.people, [[{ userId: 'u-ada', displayName: 'Ada Lovelace' }]]);
  assert.deepEqual(calls.conversations, []);
});

test('call start: never while a call is live, before the card or at confirm; a second one is refused', async () => {
  // Live before: refused with no request and no card.
  let requests = 0;
  const busy = fakeCalls({ live: { title: 'Alpha huddle' } });
  const before = await confirmAndRun('call', { action: 'start', target: { kind: 'team', name: 'platform' } }, toolContext({ social: fakeSocial(), calls: busy, fetch: async () => { requests++; throw new Error('network'); } }));
  assert.equal(before.card, null);
  assert.equal(before.result.outcome, 'refused');
  assert.match(String(before.result.output['reason']), /^You are already in a call/);
  assert.equal(requests, 0);
  assert.deepEqual([busy.conversations, busy.people], [[], []]);
  // The first call starts; a second start_call is refused and calls the host no more.
  const calls = fakeCalls();
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, TEAM)]);
  const ctx = toolContext({ fetch, social: fakeSocial(), calls });
  assert.equal((await confirmAndRun('call', { action: 'start', target: { kind: 'team', name: 'platform' } }, ctx)).result.outcome, 'done');
  const second = await confirmAndRun('call', { action: 'start', target: { kind: 'channel', name: 'general' } }, ctx);
  assert.match(String(second.result.output['reason']), /^You are already in a call/);
  assert.equal(calls.conversations.length, 1, 'the host was called once');
  // A call that began while the card was up: the runner checks again at confirm.
  const late = fakeCalls();
  const prepared = prepareToolCall('call', { action: 'start', target: { kind: 'team', name: 'platform' } }, ctx);
  assert.ok(prepared.ok);
  const lateCtx = toolContext({ fetch, social: fakeSocial(), calls: late });
  const planned = await planPreparedCall(prepared.call, lateCtx, VOICE_PLANNERS);
  assert.ok(planned && 'plan' in planned);
  late.live = { title: 'a ring that was answered' };
  const ran = await runPreparedCall(prepared.call, lateCtx, VOICE_RUNNERS, planned.plan.data);
  assert.equal(ran.outcome, 'refused');
  assert.deepEqual(late.conversations, []);
});

test('call start: refused without the Social grant, without a call host, and when calls are unavailable; ambiguous names start nothing', async () => {
  let requests = 0;
  const noNet = async () => { requests++; throw new Error('network'); };
  const noGrant = await confirmAndRun('call', { action: 'start', target: { kind: 'team', name: 'platform' } }, toolContext({ fetch: noNet, social: null, calls: fakeCalls() }));
  assert.match(String(noGrant.result.output['reason']), /Social/);
  const noHost = await confirmAndRun('call', { action: 'start', target: { kind: 'team', name: 'platform' } }, toolContext({ fetch: noNet, social: fakeSocial(), calls: null }));
  assert.equal(noHost.result.outcome, 'refused');
  const down = await confirmAndRun('call', { action: 'start', target: { kind: 'team', name: 'platform' } }, toolContext({ fetch: noNet, social: fakeSocial(), calls: fakeCalls({ unavailable: 'Calls are not available here' }) }));
  assert.equal(down.result.output['reason'], 'Calls are not available here');
  assert.equal(requests, 0);
  const calls = fakeCalls();
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, { kind: 'person', match: null, candidates: [{ id: 'u1', name: 'Ada A' }, { id: 'u2', name: 'Ada B' }] })]);
  const amb = await confirmAndRun('call', { action: 'start', target: { kind: 'dm', name: 'Ada' } }, toolContext({ fetch, social: fakeSocial(), calls }));
  assert.equal(amb.result.output['kind'], 'ambiguous');
  assert.equal(amb.card, null);
  const missing = await confirmAndRun('call', { action: 'start', target: { kind: 'channel', name: 'nope' } }, toolContext({ fetch: fakeFetch([]).fetch, social: fakeSocial(), calls }));
  assert.match(String(missing.result.output['reason']), /no channel called "nope"/);
  assert.deepEqual([calls.conversations, calls.people], [[], []]);
  // Not offered outside orgiq and social.
  for (const tenant of ['assessment', 'pipelines', 'access']) {
    assert.equal(prepareToolCall('call', { action: 'start', target: { kind: 'team', name: 'p' } }, toolContext({ tenant })).ok, false, tenant);
  }
});

test('call join: walks into the huddle the index shows live in #general, once, ringing nobody; refused while in a call or where none is live', async () => {
  const general = { kind: 'channel', match: { id: 'general', name: 'General', channelId: 'c-g', channel: 'social:ch:general' }, candidates: [] };
  const huddles = { results: [{ type: 'huddle', id: 'call-g', title: 'Live huddle in #general', subtitle: 'In the huddle now: Mira Okafor, Lena Brandt', status: 'live', href: '/social/calls' }], total: 1 };
  const routes = [route('GET', '/api/social/plane/search', 200, huddles), route('GET', '/api/social/plane/resolve', 200, general)];
  const calls = fakeCalls();
  const f = fakeFetch(routes);
  const { card, result } = await confirmAndRun('call', { action: 'join', target: { kind: 'channel', name: 'general' } }, toolContext({ fetch: f.fetch, social: fakeSocial(), calls }));
  assert.deepEqual(card, { title: 'Join the huddle in #general', detail: 'In the huddle now: Mira Okafor, Lena Brandt.' });
  assert.equal(result.outcome, 'done');
  assert.deepEqual(calls.conversations, [{ channel: 'social:ch:general', title: '#general' }], 'the conversation\'s own start, which walks into its live call');
  assert.deepEqual(calls.people, [], 'nobody is rung');
  assert.ok(f.log.some((l) => l.url === '/api/social/plane/search?q=live+huddles&type=huddle&limit=50'), 'the index the activity read uses');
  assert.ok(f.log.every((l) => l.method === 'GET'), 'joining writes nothing over HTTP');
  // No target: the one live huddle in a channel is it.
  const solo = fakeCalls();
  const one = await confirmAndRun('call', { action: 'join' }, toolContext({ fetch: fakeFetch(routes).fetch, social: fakeSocial(), calls: solo }));
  assert.equal(one.result.outcome, 'done');
  assert.deepEqual(solo.conversations, [{ channel: 'social:ch:general', title: '#general' }]);
  // Already in a call: refused before any read.
  const busy = fakeFetch(routes);
  const inCall = await confirmAndRun('call', { action: 'join', target: { kind: 'channel', name: 'general' } }, toolContext({ fetch: busy.fetch, social: fakeSocial(), calls: fakeCalls({ live: { title: 'standup' } }) }));
  assert.equal(inCall.result.outcome, 'refused');
  assert.match(inCall.result.summary, /already in a call/);
  assert.equal(busy.log.length, 0);
  // Nothing live there: refused, never a new huddle.
  const quiet = fakeCalls();
  const none = await confirmAndRun('call', { action: 'join', target: { kind: 'channel', name: 'general' } }, toolContext({ fetch: fakeFetch([route('GET', '/api/social/plane/search', 200, { results: [], total: 0 }), routes[1]!]).fetch, social: fakeSocial(), calls: quiet }));
  assert.equal(none.result.outcome, 'refused');
  assert.deepEqual(quiet.conversations, []);
  // A start with no target asks where.
  const where = await confirmAndRun('call', { action: 'start' }, toolContext({ fetch: fakeFetch([]).fetch, social: fakeSocial(), calls: fakeCalls() }));
  assert.match(where.result.summary, /Say where/);
});

// ── message ──

const RESOLVED = { kind: 'team', match: { id: 't1', name: 'Platform', channelId: 'r1', channel: 'social:team:platform:general' }, candidates: [{ id: 't1', name: 'Platform' }] };

test('message: resolves through /resolve, the card shows the channel and the text, and it sends once', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, RESOLVED)]);
  const social = fakeSocial();
  const { card, result } = await confirmAndRun('message', { target: { kind: 'team', name: 'platform' }, text: "I'm out today" }, toolContext({ fetch, social }));
  assert.equal(log[0]!.url, '/api/social/plane/resolve?kind=team&name=platform');
  assert.deepEqual(card, { title: 'Post to the Platform team', detail: "I'm out today" });
  assert.equal(result.outcome, 'done');
  assert.equal(social.sends.length, 1);
  assert.deepEqual({ ...social.sends[0], deliveryId: typeof social.sends[0]!.deliveryId }, { channel: 'social:team:platform:general', text: "I'm out today", deliveryId: 'string' });
  // In the Social tenant the same read goes to /api/social; a DM resolves a person.
  const { fetch: f2, log: l2 } = fakeFetch([
    route('GET', '/api/social/resolve', 200, { kind: 'person', match: { id: 'u2', name: 'Priya', channelId: 'social:dm:u1:u2', channel: 'social:dm:u1:u2' }, candidates: [{ id: 'u2', name: 'Priya' }] }),
    route('POST', '/api/social/dms', 200, { channel: 'social:dm:u1:u2', peers: [] }),
  ]);
  const priya = fakeSocial({ api: '/api/social' });
  const dm = await confirmAndRun('message', { target: { kind: 'dm', name: 'Priya' }, text: 'hi' }, toolContext({ tenant: 'social', fetch: f2, social: priya }));
  assert.equal(l2[0]!.url, '/api/social/resolve?kind=person&name=Priya');
  assert.deepEqual(dm.card, { title: 'Message Priya', detail: 'hi' });
  // The DM is opened at confirm (G14), then the message goes.
  assert.deepEqual(l2.slice(1).map((r) => [r.method, r.url, r.body]), [['POST', '/api/social/dms', { userId: 'u2' }]]);
  assert.equal(dm.result.outcome, 'done');
  assert.deepEqual(priya.sends.map((x) => x.channel), ['social:dm:u1:u2']);
});

test('message: a retry reuses the delivery id, and after a delivered post it never sends again', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, RESOLVED)]);
  const social = fakeSocial({ failSends: 1 });
  const args = { target: { kind: 'team', name: 'platform' }, text: "I'm out today" };
  const first = await confirmAndRun('message', args, toolContext({ fetch, social }));
  assert.equal(first.result.outcome, 'failed');
  const retry = await confirmAndRun('message', args, toolContext({ fetch, social }));
  assert.equal(retry.result.outcome, 'done');
  assert.equal(social.sends.length, 2);
  assert.equal(social.sends[0]!.deliveryId, social.sends[1]!.deliveryId, 'one clientDeliveryId for the message and its retry');
  const again = await confirmAndRun('message', args, toolContext({ fetch, social }));
  assert.equal(again.card, null);
  assert.equal(again.result.output['alreadyPosted'], true);
  assert.equal(social.sends.length, 2, 'sent once');
  // A different text is a different message.
  await confirmAndRun('message', { ...args, text: 'back tomorrow' }, toolContext({ fetch, social }));
  assert.notEqual(social.sends[2]!.deliveryId, social.sends[0]!.deliveryId);
  // The memory lapses: an old delivered message may be sent again, under a fresh id.
  const book = new Map<string, DeliveryRecord>();
  const a = deliveryFor(book, 'c', 't', 0);
  book.set('c\u0000t', { ...a, state: 'sent' });
  assert.equal(deliveryFor(book, 'c', 't', 60_000).deliveryId, a.deliveryId);
  assert.notEqual(deliveryFor(book, 'c', 't', 11 * 60_000).deliveryId, a.deliveryId);
});

test('message: several matches go back as candidates with no card and no send; nothing found is a refusal', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, { kind: 'channel', match: null, candidates: [{ id: 'platform', name: 'Platform' }, { id: 'platform-ops', name: 'Platform ops' }] })]);
  const social = fakeSocial();
  const { card, result } = await confirmAndRun('message', { target: { kind: 'channel', name: 'platform' }, text: 'hello' }, toolContext({ fetch, social }));
  assert.equal(card, null);
  assert.equal(result.output['kind'], 'ambiguous');
  assert.deepEqual(result.output['candidates'], [{ id: 'platform', name: 'Platform' }, { id: 'platform-ops', name: 'Platform ops' }]);
  assert.equal(social.sends.length, 0);
  const { fetch: none } = fakeFetch([route('GET', '/api/social/plane/resolve', 404, { kind: 'team', match: null, candidates: [] })]);
  const missing = await confirmAndRun('message', { target: { kind: 'team', name: 'nobody' }, text: 'hello' }, toolContext({ fetch: none, social }));
  assert.equal(missing.result.outcome, 'refused');
  assert.equal(social.sends.length, 0);
});

test('message (G46): a channel the user never joined, or a socket that is down, refuses before any card; a failed post names its code', async () => {
  const notJoined = { kind: 'channel', match: { id: 'general', name: 'General', channelId: 'general', channel: 'social:ch:general', joined: false }, candidates: [{ id: 'general', name: 'General' }] };
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, notJoined)]);
  const social = fakeSocial();
  const outsider = await confirmAndRun('message', { target: { kind: 'channel', name: 'general' }, text: 'hello' }, toolContext({ fetch, social }));
  assert.equal(outsider.card, null, 'no card for a post that could only fail');
  assert.equal(outsider.result.outcome, 'refused');
  assert.equal(outsider.result.output['code'], 'not-a-member');
  assert.match(String(outsider.result.output['reason']), /not a member of #General/);
  assert.equal(social.sends.length, 0);
  // A member's channel posts as before.
  const { fetch: member } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, { ...notJoined, match: { ...notJoined.match, joined: true } })]);
  assert.equal((await confirmAndRun('message', { target: { kind: 'channel', name: 'general' }, text: 'hello' }, toolContext({ fetch: member, social }))).result.outcome, 'done');
  // The socket down: refused before the resolve, with the code, and no card.
  let reads = 0;
  const down = await confirmAndRun('message', { target: { kind: 'channel', name: 'general' }, text: 'hi' },
    toolContext({ fetch: async () => { reads++; throw new Error('network'); }, social: { ...fakeSocial(), unavailable: 'Social is not connected right now. Try again in a moment.' } }));
  assert.deepEqual([down.card, down.result.outcome, down.result.output['code'], reads], [null, 'refused', 'not-connected', 0]);
  // A post the gateway refused or never acknowledged carries the chat host's code.
  for (const code of ['not-a-member', 'receipt-timeout', 'timeout', 'rejected'] as const) {
    const { fetch: f } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, RESOLVED)]);
    const failing: FakeSocial = { ...fakeSocial(), send: async () => { throw Object.assign(new Error('nope'), { code }); } };
    const r = await confirmAndRun('message', { target: { kind: 'team', name: 'platform' }, text: `t-${code}` }, toolContext({ fetch: f, social: failing }));
    assert.deepEqual([r.result.outcome, r.result.output['code']], ['failed', code], code);
  }
});

// ── set_status ──

test('set_status calls setStatus and updateMetadata with the dictated message and nothing else, with no card', async () => {
  const social = fakeSocial();
  const { card, result } = await confirmAndRun('set_status', { status: 'away', message: 'out today' }, toolContext({ social }));
  assert.equal(card, null);
  assert.equal(result.outcome, 'done');
  assert.deepEqual(social.status, ['away']);
  assert.deepEqual(social.meta, [{ statusMessage: 'out today' }]);
  const plain = fakeSocial();
  await confirmAndRun('set_status', { status: 'online' }, toolContext({ social: plain }));
  assert.deepEqual([plain.status, plain.meta], [['online'], []], 'no message: the status only');
});

test('the status message rides on the presence user as the library tooltip\'s detail', () => {
  const people = presenceAvatarUsers([
    { clientId: 'k1', status: 'away', metadata: { userId: 'u1', displayName: 'Ana', statusMessage: 'out today' } },
    { clientId: 'k2', status: 'online', metadata: { userId: 'u1', displayName: 'Ana' } },
    { clientId: 'k3', status: 'online', metadata: { userId: 'u2', displayName: 'Bo' } },
    { clientId: 'k4', status: 'busy', metadata: { userId: 'u3', displayName: 'Cy', statusMessage: `  in a review ${'z'.repeat(300)}` } },
  ]);
  assert.equal(people.find((p) => p.id === 'u1')!.detail, 'out today', 'a second tab without a message keeps it');
  assert.equal(people.find((p) => p.id === 'u2')!.detail, undefined);
  assert.equal(people.find((p) => p.id === 'u3')!.detail!.length, 120);
  // The footer hands these users to the library's PresenceAvatars, whose own tooltip shows `detail` (2.510.2, G17).
  const footer = readFileSync(new URL('../../../components/shell/EmbeddedSocial.tsx', import.meta.url), 'utf8');
  const row = footer.slice(footer.indexOf('function PresenceRow('), footer.indexOf('function EmbeddedSocialPanel('));
  assert.match(row, /<PresenceAvatars [^>]*users=\{people\}/);
  assert.doesNotMatch(row, /Tooltip/, 'no portal wrap around the faces');
});

// ── caps (§6, §10) ──

test('property: no P4 result carries a string over 120 characters or a list over 10 rows', async () => {
  const huge = 'q'.repeat(3000);
  const many: VoiceComputer[] = Array.from({ length: 30 }, (_, i) => ({ id: `c${i}-${huge}`, label: `${huge}${i}`, sessionId: SID('x'), project: huge, status: 'running' }));
  const { fetch } = fakeFetch([
    route('GET', '/api/graph/projects', 200, Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, name: `${huge}${i}` }))),
    route('GET', '/api/social/plane/resolve', 200, { kind: 'team', match: null, candidates: Array.from({ length: 30 }, (_, i) => ({ id: `t${i}`, name: huge })) }),
    route('GET', ALLOWLIST_URL, 200, { prefixes: DEFAULT_PREFIXES }),
  ]);
  const stream: CommandEvent[] = [{ type: 'stdout', text: `${Array.from({ length: 80 }, () => huge).join('\n')}\n` }, { type: 'exit', exitCode: 3 }];
  const walk = (v: unknown, path: string): void => {
    // `next` (G29) is the dock's own instruction built from the code and the workspace's enums, never data: its own cap.
    if (typeof v === 'string' && path.endsWith('.next')) assert.ok(v.length <= 900, `${path} is ${v.length} characters`);
    else if (typeof v === 'string') assert.ok(v.length <= MAX_FIELD_CHARS, `${path} is ${v.length} characters`);
    else if (Array.isArray(v)) { assert.ok(v.length <= MAX_ROWS, `${path} has ${v.length} rows`); v.forEach((x, i) => walk(x, `${path}[${i}]`)); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  const ctx = toolContext({ fetch, compute: fakeCompute({ stream, computers: many }), social: fakeSocial() });
  for (const [name, args] of [
    ['computer', { action: 'run', computer: `c3-${huge}`.slice(0, 200), phrase: 'status' }], ['computer', { action: 'run', computer: 'nothing', phrase: 'status' }],
    ['computer', { action: 'start', initiatives: ['nope'] }], ['message', { target: { kind: 'team', name: 'p' }, text: 'x' }],
    ['computer', { action: 'open-shell', computer: 'nothing' }], ['set_status', { status: 'busy', message: 'm'.repeat(120) }],
  ] as const) {
    const { result } = await confirmAndRun(name, args, ctx);
    walk(result.output, name);
    assert.ok(result.summary.length <= MAX_FIELD_CHARS, name);
  }
});

// ── G39 (session vs_8bb50a16): a person the Search page showed, not only the Social roster ──

const PRIYA_ROW = { ref: 'person:p-002', title: 'Priya Raman', href: '/iq/people/p-002' };
const NOT_ON_ROSTER = route('GET', '/api/social/plane/resolve', 404, { kind: 'person', match: null, candidates: [] });
const roster = (body: unknown) => route('GET', '/api/roster/users?personIds=p-002', 200, body);

async function planOnly(name: string, args: unknown, ctx: ReturnType<typeof toolContext>) {
  const prepared = prepareToolCall(name, args, ctx);
  assert.ok(prepared.ok);
  return planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
}

function keptPeople(rows = [PRIYA_ROW]) {
  const results = new ResultMemory();
  results.keep(rows);
  return results;
}

test('G39: a person the search showed is messaged and called through the page\'s bridge (roster users), not refused as unknown', async () => {
  const { dmLobbyName } = await import('@connorhoehn/realtime-modules/client/video');
  const lobby = dmLobbyName(['u-me', 'u-priya'], { prefix: 'social:' });
  for (const [tool, args, title] of [
    ['message', { target: { kind: 'dm', name: 'Priya Raman' }, text: 'Can you look at the release?' }, 'Message Priya Raman'],
    ['call', { action: 'start', target: { kind: 'dm', name: 'Priya' } }, 'Call Priya Raman'],
  ] as const) {
    const { fetch, log } = fakeFetch([NOT_ON_ROSTER, roster({ users: [{ personId: 'p-002', userId: 'u-priya', displayName: 'Priya Raman', social: true }], unlinked: [] })]);
    const planned = await planOnly(tool, args, toolContext({ fetch, social: fakeSocial(), calls: fakeCalls(), results: keptPeople() }));
    assert.ok(planned && 'plan' in planned, `${tool}: ${JSON.stringify(planned)}`);
    assert.equal(planned.plan.title, title);
    const data = planned.plan.data as { userId: string; channel: string };
    assert.equal(data.userId, 'u-priya');
    assert.equal(data.channel, lobby);
    assert.ok(!log.some((r) => r.method === 'POST'), 'nothing is opened before the confirm');
    assert.ok(log.some((r) => r.url === '/api/roster/users?personIds=p-002'));
  }
});

test('G39: the page\'s own rules: no Work sign-in, not in Social; nothing kept and nothing found asks for a search; no DM is opened', async () => {
  const unlinked = fakeFetch([NOT_ON_ROSTER, roster({ users: [], unlinked: ['p-002'] })]);
  const a = await planOnly('message', { target: { kind: 'dm', name: 'Priya Raman' }, text: 'hi' }, toolContext({ fetch: unlinked.fetch, social: fakeSocial(), results: keptPeople() }));
  assert.ok(a && 'result' in a);
  assert.match(String(a.result.output['reason']), /no Work sign-in/);

  const outside = fakeFetch([NOT_ON_ROSTER, roster({ users: [{ personId: 'p-002', userId: 'u-priya', displayName: 'Priya Raman', social: false }], unlinked: [] })]);
  const b = await planOnly('message', { target: { kind: 'dm', name: 'Priya Raman' }, text: 'hi' }, toolContext({ fetch: outside.fetch, social: fakeSocial(), results: keptPeople() }));
  assert.ok(b && 'result' in b);
  assert.match(String(b.result.output['reason']), /is not in Social/);

  const empty = fakeFetch([NOT_ON_ROSTER, route('GET', '/api/search', 200, { results: [], total: 0 })]);
  const c = await planOnly('message', { target: { kind: 'dm', name: 'Nobody Here' }, text: 'hi' }, toolContext({ fetch: empty.fetch, social: fakeSocial(), results: new ResultMemory() }));
  assert.ok(c && 'result' in c);
  assert.match(String(c.result.output['reason']), /No one in Social or the directory is called "Nobody Here"\. Search people first/);
  assert.ok(empty.log.some((r) => r.url.startsWith('/api/search?') && r.url.includes('type=person')), 'one person search when nothing is kept');
  for (const l of [unlinked.log, outside.log, empty.log]) assert.ok(!l.some((r) => r.method === 'POST'));
});

test('G39: with nothing kept, one person search finds them; two matches are a choice; the Social tenant keeps its roster answer', async () => {
  const { fetch } = fakeFetch([NOT_ON_ROSTER, route('GET', '/api/search', 200, { results: [{ id: 'p-002', title: 'Priya Raman', type: 'person', href: '/iq/people/p-002' }] }),
    roster({ users: [{ personId: 'p-002', userId: 'u-priya', displayName: 'Priya Raman', social: true }], unlinked: [] })]);
  const found = await planOnly('message', { target: { kind: 'dm', name: 'Priya Raman' }, text: 'hi' }, toolContext({ fetch, social: fakeSocial(), results: new ResultMemory() }));
  assert.ok(found && 'plan' in found);
  const two = fakeFetch([NOT_ON_ROSTER]);
  const both = await planOnly('message', { target: { kind: 'dm', name: 'Priya' }, text: 'hi' }, toolContext({ fetch: two.fetch, social: fakeSocial(),
    results: keptPeople([PRIYA_ROW, { ref: 'person:p-090', title: 'Priya Venkataraman', href: '/iq/people/p-090' }]) }));
  assert.ok(both && 'result' in both);
  assert.equal(both.result.output['kind'], 'ambiguous');
  const social = fakeFetch([route('GET', '/api/social/resolve', 404, { kind: 'person', match: null, candidates: [] })]);
  const inSocial = await planOnly('message', { target: { kind: 'dm', name: 'Priya Raman' }, text: 'hi' }, toolContext({ tenant: 'social', fetch: social.fetch, social: fakeSocial({ api: '/api/social' }), results: keptPeople() }));
  assert.ok(inSocial && 'result' in inSocial);
  assert.match(String(inSocial.result.output['reason']), /There is no person called "Priya Raman" you can post to/);
});

test('G39: list dm with a scope it does not take says what to change', async () => {
  const { fetch } = fakeFetch([]);
  // G49: "all" is every kind's widest read now, so the scope it does not take is "mine".
  const prepared = prepareToolCall('list', { kind: 'dm', filter: { scope: 'mine', q: 'Priya' } }, toolContext({ fetch, social: fakeSocial() }));
  const r = prepared.ok ? await runPreparedCall(prepared.call, toolContext({ fetch, social: fakeSocial() }), VOICE_RUNNERS) : prepared.result;
  assert.equal(r.outcome, 'refused');
  assert.match(String(r.output['reason']), /take no scope; leave filter\.scope out|use ".*", or leave filter\.scope out/);
  assert.equal(r.output['code'], 'invalid-arguments');
});

// ── G24: message with a read-only share of a record ──

const AUTH_ROW = { ref: 'work-item:w-7', title: 'Fix the login redirect loop', href: '/iq/projects/p-auth?item=w-7' };

test('G24: a channel post with attach grants the conversation a read-only view first, then posts with the link', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, TEAM), route('POST', '/api/social/plane/work-sharing', 201, { grant: { id: 'wsg-1' } })]);
  const social = fakeSocial();
  const results = new ResultMemory();
  results.keep([AUTH_ROW]);
  const { card, result } = await confirmAndRun('message', { target: { kind: 'team', name: 'platform' }, text: 'Have a look', attach: '1' }, toolContext({ fetch, social, results }));
  assert.deepEqual(card, { title: 'Post to the Platform team', detail: ['Have a look', 'With a read-only view of "Fix the login redirect loop" for 24 hours.'] });
  assert.equal(result.outcome, 'done');
  const share = log.find((r) => r.method === 'POST')!;
  assert.equal(share.url, '/api/social/plane/work-sharing');
  assert.deepEqual(share.body, { audience: { kind: 'conversation', id: TEAM.match.channel }, nodeIds: ['work:w-7'], disclosure: 'summary', durationMs: 86_400_000 });
  assert.equal(social.sends.length, 1);
  assert.equal(social.sends[0]!.text, 'Have a look\nFix the login redirect loop: /iq/projects/p-auth?item=w-7', 'the posted message carries the share href');
});

test('G24: a person in the workspace gets the DM with the record as a page reference; one outside it is refused before anything is sent', async () => {
  const results = new ResultMemory();
  results.keep([AUTH_ROW]);
  const inside = fakeFetch([route('GET', '/api/social/plane/resolve', 200, ADA), route('GET', '/api/roster/users?userIds=u-ada', 200, { inTenant: ['u-ada'], outside: [] }),
    route('POST', '/api/social/dms', 200, { channel: ADA.match.channel, peers: [] }), route('POST', '/api/social/plane/work-sharing', 201, { grant: { id: 'wsg-2' } })]);
  const social = fakeSocial();
  const ok = await confirmAndRun('message', { target: { kind: 'dm', name: 'Ada' }, text: 'Read-only view of my ticket', attach: 'work-item:w-7' }, toolContext({ fetch: inside.fetch, social, results }));
  assert.equal(ok.result.outcome, 'done');
  assert.deepEqual(inside.log.filter((r) => r.method === 'POST').map((r) => r.url), ['/api/social/dms', '/api/social/plane/work-sharing']);
  assert.deepEqual(social.sends[0]!.pageReference, { kind: 'work-item', id: 'w-7' });
  assert.equal(social.sends[0]!.text, 'Read-only view of my ticket');

  const outside = fakeFetch([route('GET', '/api/social/plane/resolve', 200, ADA), route('GET', '/api/roster/users?userIds=u-ada', 200, { inTenant: [], outside: ['u-ada'] })]);
  const other = fakeSocial();
  const no = await confirmAndRun('message', { target: { kind: 'dm', name: 'Ada' }, text: 'Read-only view of my ticket', attach: 'work-item:w-7' }, toolContext({ fetch: outside.fetch, social: other, results }));
  assert.equal(no.card, null);
  assert.equal(no.result.outcome, 'refused');
  assert.match(String(no.result.output['reason']), /has no access to this workspace/);
  assert.equal(other.sends.length, 0);
  assert.ok(!outside.log.some((r) => r.method === 'POST'));
});

test('G24: a record this session never read, or one the share route refuses, sends nothing', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, TEAM)]);
  const social = fakeSocial();
  const unknown = await confirmAndRun('message', { target: { kind: 'team', name: 'platform' }, text: 'x', attach: 'work-item:w-404' }, toolContext({ fetch, social, results: new ResultMemory() }));
  assert.equal(unknown.result.outcome, 'refused');
  const results = new ResultMemory();
  results.keep([AUTH_ROW]);
  const denied = fakeFetch([route('GET', '/api/social/plane/resolve', 200, TEAM), route('POST', '/api/social/plane/work-sharing', 404, { error: 'no such conversation' })]);
  const r = await confirmAndRun('message', { target: { kind: 'team', name: 'platform' }, text: 'x', attach: '1' }, toolContext({ fetch: denied.fetch, social, results }));
  assert.equal(r.result.outcome, 'refused');
  assert.match(String(r.result.output['reason']), /cannot be granted/);
  assert.equal(social.sends.length, 0);
});
