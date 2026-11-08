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
  MAX_FIELD_CHARS, MAX_ROWS, planPreparedCall, prepareToolCall, runPreparedCall,
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

interface FakeCompute extends ComputeAccess { created: Array<{ label?: string; projectId?: string }>; shells: unknown[]; commands: Array<{ sessionId: string; body: unknown }> }
function fakeCompute(opts: { canManage?: boolean; stream?: CommandEvent[]; fail?: string; computers?: VoiceComputer[] } = {}): FakeCompute {
  const created: FakeCompute['created'] = [];
  const shells: unknown[] = [];
  const commands: FakeCompute['commands'] = [];
  return {
    created, shells, commands,
    canManage: opts.canManage ?? true,
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

interface FakeSocial extends SocialAccess { sends: Array<{ channel: string; text: string; deliveryId: string }>; status: unknown[]; meta: unknown[] }
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
async function confirmAndRun(name: string, args: unknown, ctx: ReturnType<typeof toolContext>): Promise<{ card: { title: string; detail?: string } | null; result: ToolResult }> {
  const prepared = prepareToolCall(name, args, ctx);
  if (!prepared.ok) return { card: null, result: prepared.result };
  const planned = await planPreparedCall(prepared.call, ctx, VOICE_PLANNERS);
  if (planned && 'result' in planned) return { card: null, result: planned.result };
  const card = planned ? { title: planned.plan.title, ...(planned.plan.detail ? { detail: planned.plan.detail } : {}) } : null;
  return { card, result: await runPreparedCall(prepared.call, ctx, VOICE_RUNNERS, planned?.plan.data) };
}

const P4_REFUSALS: Array<{ tool: string; args: Record<string, unknown>; deny: string[] }> = [
  { tool: 'start_computer', args: { initiativeIds: ['p1'] }, deny: ['ManageDevbox'] },
  { tool: 'open_shell', args: { computerId: 'c-alpha' }, deny: ['OpenDevboxShell'] },
  { tool: 'run_command', args: { computerId: 'c-alpha', phrase: 'status' }, deny: ['OpenDevboxShell'] },
  { tool: 'send_chat_message', args: { target: { kind: 'team', name: 'platform' }, text: 'out today' }, deny: ['PostMessage'] },
  { tool: 'start_call', args: { target: { kind: 'team', name: 'platform' } }, deny: ['StartCall'] },
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
    assert.deepEqual([compute.created, compute.shells, compute.commands, social.sends], [[], [], [], []], tool);
  }
  // §6: the refusal is said the way the button's own gate would.
  const r = prepareToolCall('run_command', { computerId: 'c', phrase: 'status' }, toolContext({ deny: ['OpenDevboxShell'] }));
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
  const { card, result } = await confirmAndRun('run_command', { computerId: 'alpha-1', phrase: 'status', command: 'rm -rf /' }, c);
  assert.deepEqual(card, { title: 'Run on alpha-1', detail: 'git status' });
  assert.deepEqual(compute.commands, [{ sessionId: SID('a'), body: { command: 'git status', mode: 'safe', cwd: '/mnt/workspace/alpha' } }]);
  assert.equal(result.outcome, 'done');
  assert.deepEqual((result.output['ignored'] as { fields: string[] }).fields, ['command']);
  assert.doesNotMatch(JSON.stringify(result.output), /rm -rf/);
  // A command with no phrase is refused outright: nothing composes it, nothing runs.
  const bare = await confirmAndRun('run_command', { computerId: 'alpha-1', command: 'git log --since=yesterday' }, toolContext({ compute: fakeCompute() }));
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
  const { result } = await confirmAndRun('run_command', { computerId: 'c-alpha', phrase: 'latest-commits-since-yesterday' }, toolContext({ compute, fetch: allowlist().fetch, showOutput: (v) => { views.push(v); } }));
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
  const { result } = await confirmAndRun('run_command', { computerId: 'c-alpha', phrase: 'status' }, toolContext({ compute, fetch: allowlist().fetch, showOutput: () => false }));
  assert.equal(result.outcome, 'done');
  assert.deepEqual(result.output['lines'], ['a', 'b']);
  assert.match(String(result.output['outputTab']), /in use/);
});

test('run_command: the card never shows a command the server\'s allowlist refuses; the planner reads the allowlist and refuses offline', async () => {
  // The default allowlist has no npm: test, lint and build end before the card, and nothing is sent.
  for (const phrase of ['test', 'lint', 'build']) {
    const compute = fakeCompute();
    const f = allowlist();
    const { card, result } = await confirmAndRun('run_command', { computerId: 'c-alpha', phrase }, toolContext({ compute, fetch: f.fetch }));
    assert.equal(card, null, phrase);
    assert.equal(result.outcome, 'refused');
    assert.match(String(result.output['reason']), /safe mode does not run .*open the shell/);
    assert.deepEqual(compute.commands, []);
    assert.deepEqual(f.log.map((r) => r.url), [ALLOWLIST_URL], 'one read, the allowlist');
  }
  // Opted in with npm test: test gets its card, lint still does not.
  const opted = [...DEFAULT_PREFIXES, 'npm test'];
  assert.deepEqual((await confirmAndRun('run_command', { computerId: 'c-alpha', phrase: 'test' }, toolContext({ compute: fakeCompute(), fetch: allowlist(opted).fetch }))).card,
    { title: 'Run on alpha-1', detail: 'npm test' });
  assert.equal((await confirmAndRun('run_command', { computerId: 'c-alpha', phrase: 'lint' }, toolContext({ compute: fakeCompute(), fetch: allowlist(opted).fetch }))).card, null);
  // A since token the allowlist's prefix does not cover is caught on the composed text, not the phrase.
  const narrow = await confirmAndRun('run_command', { computerId: 'c-alpha', phrase: 'commits-since', since: '3 days ago' }, toolContext({ compute: fakeCompute(), fetch: allowlist(['git log --since=yesterday']).fetch }));
  assert.equal(narrow.card, null);
  assert.equal(narrow.result.outcome, 'refused');
  // No read of the allowlist (403) is the role refusal, never a card.
  const denied = await confirmAndRun('run_command', { computerId: 'c-alpha', phrase: 'status' }, toolContext({ compute: fakeCompute(), fetch: fakeFetch([route('GET', ALLOWLIST_URL, 403, { error: 'Forbidden' })]).fetch }));
  assert.equal(denied.card, null);
  assert.match(String(denied.result.output['reason']), /can't run commands/);
});

test('run_command: the server refusing a phrase in safe mode is still a refusal that says to open the shell', async () => {
  // The allowlist read admitted it (opted in), the server's own check refused it anyway (the backstop).
  const compute = fakeCompute({ fail: 'not an allowlisted read-only command — switch to full shell to run it' });
  const { result } = await confirmAndRun('run_command', { computerId: 'c-alpha', phrase: 'build' }, toolContext({ compute, fetch: allowlist([...DEFAULT_PREFIXES, 'npm run build']).fetch }));
  assert.equal(result.outcome, 'refused');
  assert.match(String(result.output['reason']), /open the shell and type it/);
  assert.equal((compute.commands[0]!.body as { mode: string }).mode, 'safe');
});

test('run_command and open_shell: an unknown or ambiguous computer goes back as candidates; a laptop is never a target', async () => {
  const { result } = await confirmAndRun('run_command', { computerId: 'gamma', phrase: 'status' }, toolContext({ compute: fakeCompute() }));
  assert.equal(result.output['kind'], 'ambiguous');
  assert.deepEqual((result.output['candidates'] as Array<{ id: string }>).map((c) => c.id), ['c-alpha', 'c-beta']);
  const laptop = await confirmAndRun('open_shell', { computerId: 'c-laptop' }, toolContext({ compute: fakeCompute() }));
  assert.equal(laptop.result.output['kind'], 'ambiguous');
});

// ── open_shell ──

test('open_shell opens (or focuses) the lab\'s shell tab with no card, by label or initiative name', async () => {
  const compute = fakeCompute();
  const { card, result } = await confirmAndRun('open_shell', { computerId: 'Alpha' }, toolContext({ compute }));
  assert.equal(card, null);
  assert.equal(result.outcome, 'done');
  assert.deepEqual(compute.shells, [{ id: 'c-alpha', label: 'alpha-1', sessionId: SID('a'), cwd: '/mnt/workspace/alpha' }]);
  const full = fakeCompute();
  full.openShell = () => ({ ok: false, reason: 'at-capacity' });
  assert.equal((await confirmAndRun('open_shell', { computerId: 'c-alpha' }, toolContext({ compute: full }))).result.outcome, 'refused');
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
  const prepared = prepareToolCall('start_computer', { initiativeIds: ['p1', 'Beta', 'gamma'] }, ctx);
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
  const missing = await confirmAndRun('start_computer', { initiativeIds: ['Delta'] }, toolContext({ fetch, compute: fakeCompute() }));
  assert.equal(missing.result.output['kind'], 'ambiguous');
  assert.equal((missing.result.output['candidates'] as unknown[]).length, 3);
  const compute = fakeCompute();
  const running = await confirmAndRun('start_computer', { initiativeIds: ['Alpha'] }, toolContext({ fetch, compute }));
  assert.equal(running.card, null);
  assert.equal(running.result.outcome, 'done');
  assert.deepEqual(compute.created, []);
  assert.equal((await confirmAndRun('start_computer', { initiativeIds: ['p1'] }, toolContext({ fetch, compute: fakeCompute({ canManage: false }) }))).result.outcome, 'refused');
});

// ── start_call (G7) ──

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

test('start_call: a team resolves through /resolve, the card says nobody is rung, and confirm starts one huddle in its channel', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, TEAM)]);
  const calls = fakeCalls();
  const { card, result } = await confirmAndRun('start_call', { target: { kind: 'team', name: 'platform' } }, toolContext({ fetch, social: fakeSocial(), calls }));
  assert.deepEqual(log.map((r) => r.url), ['/api/social/plane/resolve?kind=team&name=platform']);
  assert.deepEqual(card, { title: 'Start a huddle in the Platform team', detail: 'Nobody is rung; anyone who opens it sees the huddle and can join.' });
  assert.equal(result.outcome, 'done');
  assert.deepEqual(calls.conversations, [{ channel: 'social:team:platform:general', title: 'Platform team' }]);
  assert.deepEqual(calls.people, []);
});

test('start_call: a person is a DM call that rings them, and the card says so', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/social/resolve', 200, ADA)]);
  const calls = fakeCalls();
  const { card, result } = await confirmAndRun('start_call', { target: { kind: 'dm', name: 'Ada' } }, toolContext({ tenant: 'social', fetch, social: fakeSocial({ api: '/api/social' }), calls }));
  assert.equal(log[0]!.url, '/api/social/resolve?kind=person&name=Ada');
  assert.deepEqual(card, { title: 'Call Ada Lovelace', detail: 'This rings Ada Lovelace.' });
  assert.equal(result.outcome, 'done');
  assert.deepEqual(calls.people, [[{ userId: 'u-ada', displayName: 'Ada Lovelace' }]]);
  assert.deepEqual(calls.conversations, []);
});

test('start_call: never while a call is live, before the card or at confirm; a second one is refused', async () => {
  // Live before: refused with no request and no card.
  let requests = 0;
  const busy = fakeCalls({ live: { title: 'Alpha huddle' } });
  const before = await confirmAndRun('start_call', { target: { kind: 'team', name: 'platform' } }, toolContext({ social: fakeSocial(), calls: busy, fetch: async () => { requests++; throw new Error('network'); } }));
  assert.equal(before.card, null);
  assert.equal(before.result.outcome, 'refused');
  assert.match(String(before.result.output['reason']), /^You are already in a call/);
  assert.equal(requests, 0);
  assert.deepEqual([busy.conversations, busy.people], [[], []]);
  // The first call starts; a second start_call is refused and calls the host no more.
  const calls = fakeCalls();
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, TEAM)]);
  const ctx = toolContext({ fetch, social: fakeSocial(), calls });
  assert.equal((await confirmAndRun('start_call', { target: { kind: 'team', name: 'platform' } }, ctx)).result.outcome, 'done');
  const second = await confirmAndRun('start_call', { target: { kind: 'channel', name: 'general' } }, ctx);
  assert.match(String(second.result.output['reason']), /^You are already in a call/);
  assert.equal(calls.conversations.length, 1, 'the host was called once');
  // A call that began while the card was up: the runner checks again at confirm.
  const late = fakeCalls();
  const prepared = prepareToolCall('start_call', { target: { kind: 'team', name: 'platform' } }, ctx);
  assert.ok(prepared.ok);
  const lateCtx = toolContext({ fetch, social: fakeSocial(), calls: late });
  const planned = await planPreparedCall(prepared.call, lateCtx, VOICE_PLANNERS);
  assert.ok(planned && 'plan' in planned);
  late.live = { title: 'a ring that was answered' };
  const ran = await runPreparedCall(prepared.call, lateCtx, VOICE_RUNNERS, planned.plan.data);
  assert.equal(ran.outcome, 'refused');
  assert.deepEqual(late.conversations, []);
});

test('start_call: refused without the Social grant, without a call host, and when calls are unavailable; ambiguous names start nothing', async () => {
  let requests = 0;
  const noNet = async () => { requests++; throw new Error('network'); };
  const noGrant = await confirmAndRun('start_call', { target: { kind: 'team', name: 'platform' } }, toolContext({ fetch: noNet, social: null, calls: fakeCalls() }));
  assert.match(String(noGrant.result.output['reason']), /Social/);
  const noHost = await confirmAndRun('start_call', { target: { kind: 'team', name: 'platform' } }, toolContext({ fetch: noNet, social: fakeSocial(), calls: null }));
  assert.equal(noHost.result.outcome, 'refused');
  const down = await confirmAndRun('start_call', { target: { kind: 'team', name: 'platform' } }, toolContext({ fetch: noNet, social: fakeSocial(), calls: fakeCalls({ unavailable: 'Calls are not available here' }) }));
  assert.equal(down.result.output['reason'], 'Calls are not available here');
  assert.equal(requests, 0);
  const calls = fakeCalls();
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, { kind: 'person', match: null, candidates: [{ id: 'u1', name: 'Ada A' }, { id: 'u2', name: 'Ada B' }] })]);
  const amb = await confirmAndRun('start_call', { target: { kind: 'dm', name: 'Ada' } }, toolContext({ fetch, social: fakeSocial(), calls }));
  assert.equal(amb.result.output['kind'], 'ambiguous');
  assert.equal(amb.card, null);
  const missing = await confirmAndRun('start_call', { target: { kind: 'channel', name: 'nope' } }, toolContext({ fetch: fakeFetch([]).fetch, social: fakeSocial(), calls }));
  assert.match(String(missing.result.output['reason']), /no channel called "nope"/);
  assert.deepEqual([calls.conversations, calls.people], [[], []]);
  // Not offered outside orgiq and social.
  for (const tenant of ['assessment', 'pipelines', 'access']) {
    assert.equal(prepareToolCall('start_call', { target: { kind: 'team', name: 'p' } }, toolContext({ tenant })).ok, false, tenant);
  }
});

// ── send_chat_message ──

const RESOLVED = { kind: 'team', match: { id: 't1', name: 'Platform', channelId: 'r1', channel: 'social:team:platform:general' }, candidates: [{ id: 't1', name: 'Platform' }] };

test('send_chat_message: resolves through /resolve, the card shows the channel and the text, and it sends once', async () => {
  const { fetch, log } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, RESOLVED)]);
  const social = fakeSocial();
  const { card, result } = await confirmAndRun('send_chat_message', { target: { kind: 'team', name: 'platform' }, text: "I'm out today" }, toolContext({ fetch, social }));
  assert.equal(log[0]!.url, '/api/social/plane/resolve?kind=team&name=platform');
  assert.deepEqual(card, { title: 'Post to the Platform team', detail: "I'm out today" });
  assert.equal(result.outcome, 'done');
  assert.equal(social.sends.length, 1);
  assert.deepEqual({ ...social.sends[0], deliveryId: typeof social.sends[0]!.deliveryId }, { channel: 'social:team:platform:general', text: "I'm out today", deliveryId: 'string' });
  // In the Social tenant the same read goes to /api/social; a DM resolves a person.
  const { fetch: f2, log: l2 } = fakeFetch([route('GET', '/api/social/resolve', 200, { kind: 'person', match: { id: 'u2', name: 'Priya', channelId: 'social:dm:u1:u2', channel: 'social:dm:u1:u2' }, candidates: [{ id: 'u2', name: 'Priya' }] })]);
  const dm = await confirmAndRun('send_chat_message', { target: { kind: 'dm', name: 'Priya' }, text: 'hi' }, toolContext({ tenant: 'social', fetch: f2, social: fakeSocial({ api: '/api/social' }) }));
  assert.equal(l2[0]!.url, '/api/social/resolve?kind=person&name=Priya');
  assert.deepEqual(dm.card, { title: 'Message Priya', detail: 'hi' });
});

test('send_chat_message: a retry reuses the delivery id, and after a delivered post it never sends again', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, RESOLVED)]);
  const social = fakeSocial({ failSends: 1 });
  const args = { target: { kind: 'team', name: 'platform' }, text: "I'm out today" };
  const first = await confirmAndRun('send_chat_message', args, toolContext({ fetch, social }));
  assert.equal(first.result.outcome, 'failed');
  const retry = await confirmAndRun('send_chat_message', args, toolContext({ fetch, social }));
  assert.equal(retry.result.outcome, 'done');
  assert.equal(social.sends.length, 2);
  assert.equal(social.sends[0]!.deliveryId, social.sends[1]!.deliveryId, 'one clientDeliveryId for the message and its retry');
  const again = await confirmAndRun('send_chat_message', args, toolContext({ fetch, social }));
  assert.equal(again.card, null);
  assert.equal(again.result.output['alreadyPosted'], true);
  assert.equal(social.sends.length, 2, 'sent once');
  // A different text is a different message.
  await confirmAndRun('send_chat_message', { ...args, text: 'back tomorrow' }, toolContext({ fetch, social }));
  assert.notEqual(social.sends[2]!.deliveryId, social.sends[0]!.deliveryId);
  // The memory lapses: an old delivered message may be sent again, under a fresh id.
  const book = new Map<string, DeliveryRecord>();
  const a = deliveryFor(book, 'c', 't', 0);
  book.set('c\u0000t', { ...a, state: 'sent' });
  assert.equal(deliveryFor(book, 'c', 't', 60_000).deliveryId, a.deliveryId);
  assert.notEqual(deliveryFor(book, 'c', 't', 11 * 60_000).deliveryId, a.deliveryId);
});

test('send_chat_message: several matches go back as candidates with no card and no send; nothing found is a refusal', async () => {
  const { fetch } = fakeFetch([route('GET', '/api/social/plane/resolve', 200, { kind: 'channel', match: null, candidates: [{ id: 'platform', name: 'Platform' }, { id: 'platform-ops', name: 'Platform ops' }] })]);
  const social = fakeSocial();
  const { card, result } = await confirmAndRun('send_chat_message', { target: { kind: 'channel', name: 'platform' }, text: 'hello' }, toolContext({ fetch, social }));
  assert.equal(card, null);
  assert.equal(result.output['kind'], 'ambiguous');
  assert.deepEqual(result.output['candidates'], [{ id: 'platform', name: 'Platform' }, { id: 'platform-ops', name: 'Platform ops' }]);
  assert.equal(social.sends.length, 0);
  const { fetch: none } = fakeFetch([route('GET', '/api/social/plane/resolve', 404, { kind: 'team', match: null, candidates: [] })]);
  const missing = await confirmAndRun('send_chat_message', { target: { kind: 'team', name: 'nobody' }, text: 'hello' }, toolContext({ fetch: none, social }));
  assert.equal(missing.result.outcome, 'refused');
  assert.equal(social.sends.length, 0);
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
    if (typeof v === 'string') assert.ok(v.length <= MAX_FIELD_CHARS, `${path} is ${v.length} characters`);
    else if (Array.isArray(v)) { assert.ok(v.length <= MAX_ROWS, `${path} has ${v.length} rows`); v.forEach((x, i) => walk(x, `${path}[${i}]`)); }
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  const ctx = toolContext({ fetch, compute: fakeCompute({ stream, computers: many }), social: fakeSocial() });
  for (const [name, args] of [
    ['run_command', { computerId: `c3-${huge}`.slice(0, 200), phrase: 'status' }], ['run_command', { computerId: 'nothing', phrase: 'status' }],
    ['start_computer', { initiativeIds: ['nope'] }], ['send_chat_message', { target: { kind: 'team', name: 'p' }, text: 'x' }],
    ['open_shell', { computerId: 'nothing' }], ['set_status', { status: 'busy', message: 'm'.repeat(120) }],
  ] as const) {
    const { result } = await confirmAndRun(name, args, ctx);
    walk(result.output, name);
    assert.ok(result.summary.length <= MAX_FIELD_CHARS, name);
  }
});
