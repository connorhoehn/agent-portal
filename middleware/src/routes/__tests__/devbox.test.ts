// src/routes/__tests__/devbox.test.ts
//
// Unit tests for the devbox routes (devbox.ts) with a mocked AgentCore data
// client. Covers:
//   1. POST /sessions mints a ≥33-char session id (and honours a compliant one)
//   2. Short :sessionId params are rejected with 400
//   3. Command allowlist: disallowed commands and shell metacharacters → 400
//   4. Command happy path: chunk stream → SSE stdout/exit frames
//   5. Task requires a prompt
//   6. Task happy path: upstream SSE body re-framed as SSE data frames
//   7. DELETE stops the runtime session with the right parameters
//   8. Per-computer scoping: an SME reaches their own and their initiative's,
//      and nothing else (lib/devbox-visibility.ts)

import express from 'express';
import request from '../../test-support/http.js';
import {
  devboxRouter,
  _internal,
  validateCommand,
  buildContainerCommand,
  validateCwd,
  CWD_MARKER,
  stopDevboxSessionForSourceControl,
} from '../devbox.js';
import { type Session } from '../../lib/session.js';
import { registerBox, _resetFleet, getBoxBySession, getBox } from '../../lib/devbox-fleet.js';
import { decideReaping, MAX_LIFETIME_MS } from '../../lib/devbox-reaper.js';
import { recordSpend } from '../../providers/spend-ledger.js';
// The DE-42 box-action gate (lib/agent-actions.ts) asks Cedar through
// authz.ts, which this suite cannot load (config.ts uses import.meta). The
// gate has its own suite (routes/__tests__/agent-actions-routes.test.ts);
// here it passes through so the routes' own behaviour is what is tested.
jest.mock('../../lib/agent-actions.js', () => ({
  requireBoxAction: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../providers/spend-ledger.js', () => ({ recordSpend: jest.fn(async () => undefined) }));

const SESSION = 'devbox-0123456789abcdef0123456789abcdef';
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orgiq_devbox-abc123';

/**
 * The router is mounted behind requireAction('ManageDevbox') in index.ts, so a
 * request that reaches it always carries a session. The harness has to supply
 * one or every per-computer check reads as "no session" and denies — which is
 * correct behaviour against an unfaithful setup.
 *
 * Defaults to hr-admin: fleet-wide, so the tests that predate scoping keep
 * asking what they were asking. Pass a session to scope a request down.
 */
function buildApp(session: Partial<Session> | null = { role: 'hr-admin' }) {
  const app = express();
  app.use(express.json());
  if (session) {
    app.use((req, _res, next) => {
      req.session = {
        sub: 'u-test', role: 'hr-admin', tenant: 'orgiq', grants: {}, iat: 0,
        ...session,
      } as Session;
      next();
    });
  }
  app.use('/api/devbox', devboxRouter);
  return app;
}

type SentCommand = { input: Record<string, unknown>; constructor: { name: string } };

/** Minimal mock of BedrockAgentCoreClient.send(). */
function mockDataClient(impl: (command: SentCommand) => Promise<unknown>) {
  const calls: SentCommand[] = [];
  const client = {
    send: jest.fn(async (command: SentCommand) => {
      calls.push(command);
      return impl(command);
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _internal.setDataClient(client as any);
  return { client, calls };
}

async function* asyncIterOf<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

beforeEach(() => {
  process.env['DEVBOX_RUNTIME_ARN'] = ARN;
  _internal.resetArnCache();
});

afterEach(() => {
  delete process.env['DEVBOX_RUNTIME_ARN'];
  delete process.env['MOCK_AGENTCORE'];
  _internal.setDataClient(null);
});

// ─── 1. Session minting ───────────────────────────────────────────────────────

describe('POST /api/devbox/sessions', () => {
  it('mints a session id of at least 33 characters', async () => {
    const res = await request(buildApp()).post('/api/devbox/sessions').send({});
    expect(res.status).toBe(201);
    expect(res.body.sessionId.length).toBeGreaterThanOrEqual(33);
  });

  it('honours a caller-supplied compliant session id', async () => {
    const res = await request(buildApp()).post('/api/devbox/sessions').send({ sessionId: SESSION });
    expect(res.status).toBe(201);
    expect(res.body.sessionId).toBe(SESSION);
  });

  it('replaces a too-short session id instead of accepting it', async () => {
    const res = await request(buildApp()).post('/api/devbox/sessions').send({ sessionId: 'short' });
    expect(res.status).toBe(201);
    expect(res.body.sessionId).not.toBe('short');
    expect(res.body.sessionId.length).toBeGreaterThanOrEqual(33);
  });
});

// ─── 2. Session id validation on session-scoped routes ───────────────────────

describe('session id validation', () => {
  it('rejects a short sessionId on /command', async () => {
    const res = await request(buildApp())
      .post('/api/devbox/tooshort/command')
      .send({ command: 'git status' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/33/);
  });
});

// ─── 3. Command allowlist ────────────────────────────────────────────────────

describe('validateCommand', () => {
  it.each(['git status', 'git log --oneline', 'ls -la', 'pytest', 'python -m pytest -q'])(
    'allows %s', (cmd) => expect(validateCommand(cmd)).toBeNull(),
  );

  it.each(['rm -rf /', 'curl https://example.com', 'npm install evil'])(
    'rejects non-allowlisted %s in safe mode', (cmd) => expect(validateCommand(cmd)).toMatch(/allowlisted/),
  );

  it.each(['rm -rf /tmp/x', 'npm install', 'grep -r "foo bar" .', 'echo hi > f && cat f'])(
    'allows %s in full mode', (cmd) => expect(validateCommand(cmd, 'full')).toBeNull(),
  );

  it('points at full mode rather than just refusing', () => {
    // The old message listed prefixes and left you stuck; the way forward has
    // to be in the error or nobody finds it.
    expect(validateCommand('grep foo .')).toMatch(/full shell/);
    expect(validateCommand('ls | wc -l')).toMatch(/full shell/);
  });

  it('can have full mode switched off for a locked-down deployment', () => {
    process.env['DEVBOX_FULL_EXEC_DISABLED'] = '1';
    try {
      expect(validateCommand('rm -rf /tmp/x', 'full')).toMatch(/disabled/);
      expect(validateCommand('ls', 'safe')).toBeNull();
    } finally {
      delete process.env['DEVBOX_FULL_EXEC_DISABLED'];
    }
  });

  it.each(['git status; rm -rf /', 'ls && whoami', 'cat `id`', 'ls | tee /tmp/x', 'cat $(pwd)',
           "git log --format='%h'", 'cat "x y"'])(
    'rejects metacharacters in %s', (cmd) => expect(validateCommand(cmd)).toMatch(/metacharacters/),
  );

  it('honours the DEVBOX_COMMAND_ALLOWLIST override', () => {
    process.env['DEVBOX_COMMAND_ALLOWLIST'] = 'echo hello';
    try {
      expect(validateCommand('echo hello')).toBeNull();
      expect(validateCommand('git status')).toMatch(/allowlist/);
    } finally {
      delete process.env['DEVBOX_COMMAND_ALLOWLIST'];
    }
  });
});

// ─── 4. Command happy path ───────────────────────────────────────────────────

describe('POST /api/devbox/:sessionId/command', () => {
  it('streams stdout/stderr deltas and the exit event as SSE', async () => {
    const { calls } = mockDataClient(async () => ({
      stream: asyncIterOf([
        { chunk: { contentStart: {} } },
        { chunk: { contentDelta: { stdout: 'On branch main\n' } } },
        { chunk: { contentDelta: { stderr: 'warning: something\n' } } },
        { chunk: { contentStop: { exitCode: 0, status: 'COMPLETED' } } },
      ]),
    }));

    const res = await request(buildApp())
      .post(`/api/devbox/${SESSION}/command`)
      .send({ command: 'git status' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.text).toContain('"type":"stdout"');
    expect(res.text).toContain('On branch main');
    expect(res.text).toContain('"type":"stderr"');
    expect(res.text).toContain('"type":"exit"');
    expect(res.text).toContain('"exitCode":0');

    // Server wraps in `sh -c '...'` (the command API exec's argv, no shell).
    // The user's text is carried as base64 and decoded inside the container,
    // so it deliberately does NOT appear as shell source — that is what makes
    // quoting and injection a non-issue.
    const input = calls[0]!.input as { body: { command: string }; runtimeSessionId: string };
    expect(input.body.command).toMatch(/^sh -c '/);
    expect(input.body.command).toContain('cd "$1"');
    expect(input.body.command).not.toContain('git status');
    expect(input.body.command).toContain(Buffer.from('git status', 'utf8').toString('base64'));
    expect(input.runtimeSessionId).toBe(SESSION);
  });

  it('rejects a disallowed command without calling AWS', async () => {
    const { client } = mockDataClient(async () => ({ stream: asyncIterOf([]) }));
    const res = await request(buildApp())
      .post(`/api/devbox/${SESSION}/command`)
      .send({ command: 'rm -rf /' });
    expect(res.status).toBe(400);
    expect(client.send).not.toHaveBeenCalled();
  });
});

// ─── 5+6. Task mode ──────────────────────────────────────────────────────────

describe('POST /api/devbox/:sessionId/task', () => {
  it('requires a prompt', async () => {
    mockDataClient(async () => ({ response: asyncIterOf([]) }));
    const res = await request(buildApp()).post(`/api/devbox/${SESSION}/task`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/prompt/);
  });

  it('re-frames the upstream SSE body as SSE data frames', async () => {
    const upstream = [
      'data: {"type":"devbox_start","workspace":"/mnt/workspace","workspace_persistent":true}\n',
      'data: {"type":"assistant","message":{"content":[{"type":"text","text":"done"}]}}\n',
      'data: {"type":"devbox_end","exit_code":0}\n',
    ].map((s) => new TextEncoder().encode(s));

    const { calls } = mockDataClient(async () => ({ response: asyncIterOf(upstream) }));

    const res = await request(buildApp())
      .post(`/api/devbox/${SESSION}/task`)
      .send({ prompt: 'scaffold a project', resume: true });

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"devbox_start"');
    expect(res.text).toContain('"type":"devbox_end"');

    const input = calls[0]!.input as { payload: Uint8Array; runtimeSessionId: string };
    const payload = JSON.parse(new TextDecoder().decode(input.payload));
    expect(payload.prompt).toBe('scaffold a project');
    expect(payload.resume).toBe(true);
    expect(input.runtimeSessionId).toBe(SESSION);
  });

  it('writes one box_task ledger entry with the reported cost, the box\'s initiative and the session user (DE-30)', async () => {
    (recordSpend as jest.Mock).mockClear();
    // An earlier /task test in this block adopts SESSION with no initiative;
    // start from an empty fleet so this box is the one the route reads.
    _resetFleet();
    const box = registerBox({ sessionId: SESSION, ownerId: 'u-test', projectId: 'p-auth-migration' });
    const upstream = [
      'data: {"type":"devbox_start","model":"sonnet"}\n',
      'data: {"type":"result","total_cost_usd":0.37,"usage":{"input_tokens":120,"output_tokens":45}}\n',
      'data: {"type":"devbox_end","exit_code":0}\n',
    ].map((s) => new TextEncoder().encode(s));
    mockDataClient(async () => ({ response: asyncIterOf(upstream) }));
    const res = await request(buildApp()).post(`/api/devbox/${SESSION}/task`).send({ prompt: 'fix it' });
    expect(res.status).toBe(200);
    expect(recordSpend).toHaveBeenCalledTimes(1);
    expect(recordSpend).toHaveBeenCalledWith(expect.objectContaining({
      source: 'box_task', boxId: box.id, initiativeId: 'p-auth-migration', actorId: 'u-test',
      model: 'sonnet', costUsd: 0.37, inputTokens: 120, outputTokens: 45,
    }));
  });

  it('records unknown cost when the stream ends without a result frame', async () => {
    (recordSpend as jest.Mock).mockClear();
    const upstream = ['data: {"type":"devbox_end","exit_code":1}\n'].map((s) => new TextEncoder().encode(s));
    mockDataClient(async () => ({ response: asyncIterOf(upstream) }));
    await request(buildApp()).post(`/api/devbox/${SESSION}/task`).send({ prompt: 'fix it' });
    expect(recordSpend).toHaveBeenCalledWith(expect.objectContaining({ source: 'box_task', costUsd: null }));
  });

  it('unwraps double-encoded SSE frames (wrapper yielded a string, not a dict)', async () => {
    // BedrockAgentCoreApp json-encodes yielded values; a wrapper that yields
    // pre-serialised JSON strings produces frames like: data: "{\"type\"...}"
    const doubleEncoded = `data: ${JSON.stringify('{"type":"devbox_start","workspace_persistent":true}')}\n`;
    mockDataClient(async () => ({
      response: asyncIterOf([new TextEncoder().encode(doubleEncoded)]),
    }));

    const res = await request(buildApp())
      .post(`/api/devbox/${SESSION}/task`)
      .send({ prompt: 'hello' });

    expect(res.status).toBe(200);
    // Forwarded as a clean single-encoded object frame.
    expect(res.text).toContain('data: {"type":"devbox_start"');
    expect(res.text).not.toContain('\\"type\\"');
  });
});

// ─── 7. Stop ─────────────────────────────────────────────────────────────────

describe('DELETE /api/devbox/:sessionId', () => {
  it('settles source control locally in mock mode without contacting AWS', async () => {
    process.env['MOCK_AGENTCORE'] = 'true';
    const { client } = mockDataClient(async () => {
      throw new Error('must not contact AgentCore');
    });

    await expect(stopDevboxSessionForSourceControl(SESSION)).resolves.toBe('stopped');
    expect(client.send).not.toHaveBeenCalled();
  });

  it('stops the runtime session', async () => {
    const { calls } = mockDataClient(async () => ({}));
    const res = await request(buildApp()).delete(`/api/devbox/${SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);

    const input = calls[0]!.input as { agentRuntimeArn: string; runtimeSessionId: string };
    expect(input.agentRuntimeArn).toBe(ARN);
    expect(input.runtimeSessionId).toBe(SESSION);
  });

  // Both of these reached the operator as a bare "Internal server error"
  // before, about a session that had actually stopped.

  it('treats an already-terminated session as stopped, not as an error', async () => {
    mockDataClient(async () => {
      const err = new Error('Session not found or has been terminated');
      err.name = 'ResourceNotFoundException';
      throw err;
    });
    const res = await request(buildApp()).delete(`/api/devbox/${SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stopped: true, alreadyStopped: true });
  });

  it('reports an unreadable stop response as unconfirmed, not as success', async () => {
    // The service answered with an HTML error page, so the SDK threw while
    // deserializing. The stop may or may not have taken — say so.
    mockDataClient(async () => {
      throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON');
    });
    const res = await request(buildApp()).delete(`/api/devbox/${SESSION}`);
    expect(res.status).toBe(502);
    expect(res.body.stopped).toBeUndefined();
    expect(String(res.body.error)).toMatch(/did not confirm/);
  });
});


// ─── 4. Container command construction ───────────────────────────────────────
//
// This is where a mistake becomes a shell injection or a silently broken
// terminal, so the properties are pinned rather than eyeballed.

describe('buildContainerCommand', () => {
  it('never interpolates the command into shell source', () => {
    // A quote-heavy, newline-bearing command must appear ONLY as base64.
    const nasty = `echo 'it\\'s'; rm -rf /\nprintf "x"`;
    const built = buildContainerCommand(nasty, '/mnt/workspace');
    expect(built).not.toContain('rm -rf /');
    expect(built).toContain(Buffer.from(nasty, 'utf8').toString('base64'));
  });

  it('keeps the wrapper single-quoted with no stray single quote inside it', () => {
    // The script lives inside sh -c '...'; one single quote in the body would
    // terminate it early and hand the rest to the shell as separate words.
    const built = buildContainerCommand('ls -la', '/mnt/workspace');
    const body = built.slice(built.indexOf("'") + 1, built.lastIndexOf("' orgiq"));
    expect(body).not.toContain("'");
  });

  it('passes the working directory as an argument, not as script text', () => {
    const built = buildContainerCommand('pwd', '/mnt/workspace/sub dir');
    expect(built).toContain('cd "$1"');
    expect(built.endsWith(`'/mnt/workspace/sub dir'`)).toBe(true);
  });

  it('sources the script so a cd survives into the reported cwd', () => {
    const built = buildContainerCommand('cd /tmp', '/mnt/workspace');
    expect(built).toContain('. /tmp/.orgiq-cmd');
    expect(built).toContain(CWD_MARKER);
  });

  it('redirects stdin so an input-waiting command cannot hang the terminal', () => {
    expect(buildContainerCommand('cat', '/mnt/workspace')).toContain('< /dev/null');
  });

  it("preserves the user command's exit code past the cwd report", () => {
    const built = buildContainerCommand('false', '/mnt/workspace');
    expect(built).toContain('rc=$?');
    expect(built).toContain('exit $rc');
  });
});

describe('validateCwd', () => {
  it('accepts an absolute path and an empty value', () => {
    expect(validateCwd('/mnt/workspace/pkg')).toBeNull();
    expect(validateCwd('')).toBeNull();
  });

  it.each(['relative/path', 'x'])('rejects non-absolute %s', (p) => {
    expect(validateCwd(p)).toMatch(/absolute/);
  });

  it('rejects control characters that could forge a second marker line', () => {
    expect(validateCwd('/mnt/workspace\nrm -rf /')).toMatch(/control character/);
  });
});

// ─── 8. Per-computer scoping ─────────────────────────────────────────────────
//
// Cedar's ManageDevbox got the caller onto the surface. These cover the other
// half — which computers on it are theirs — at the route, where the pure rule
// in lib/__tests__/devbox-visibility.test.ts meets real requests.
//
// `sme` is the interesting principal: it holds ManageDevbox role-wide but is
// scoped per initiative. stewardsInitiative is mocked because the real one
// resolves through identity + projects; what is under test here is that the
// routes consult it and honour the answer, not how attachment is computed.

jest.mock('../../lib/initiative-scope.js', () => ({
  ORG_WIDE_INITIATIVE_ROLES: ['org-leader', 'hr-admin', 'admin'],
  stewardsInitiative: jest.fn(async (_session: unknown, id: string) => id === 'p-mine'),
}));

describe('per-computer scoping', () => {
  const SME = { sub: 'u-nora', role: 'sme' as const };
  const OTHER_SESSION = 'devbox-fedcba9876543210fedcba9876543210';

  beforeEach(() => {
    _resetFleet();
    registerBox({ id: 'own',    sessionId: SESSION,       ownerId: 'u-nora' });
    registerBox({ id: 'shared', sessionId: OTHER_SESSION, ownerId: 'u-eli', projectId: 'p-mine' });
    registerBox({ id: 'theirs', sessionId: 'devbox-1111111111111111111111111111', ownerId: 'u-eli' });
    registerBox({ id: 'orphan', sessionId: 'devbox-2222222222222222222222222222' });
  });

  afterEach(() => _resetFleet());

  it('GET /boxes returns an SME their own and their initiative\'s, nothing else', async () => {
    const res = await request(buildApp(SME)).get('/api/devbox/boxes');
    expect(res.status).toBe(200);
    expect((res.body.boxes as { id: string }[]).map((b) => b.id).sort())
      .toEqual(['own', 'shared']);
  });

  it('GET /boxes returns everything to a fleet-wide role', async () => {
    const res = await request(buildApp({ role: 'hr-admin' })).get('/api/devbox/boxes');
    expect((res.body.boxes as { id: string }[]).map((b) => b.id).sort())
      .toEqual(['orphan', 'own', 'shared', 'theirs']);
  });

  it('403s an SME tailing a computer that is not theirs', async () => {
    const res = await request(buildApp(SME)).get('/api/devbox/boxes/theirs/tail');
    expect(res.status).toBe(403);
  });

  it('403s an SME renaming a computer that is not theirs', async () => {
    const res = await request(buildApp(SME))
      .patch('/api/devbox/boxes/theirs').send({ label: 'mine now' });
    expect(res.status).toBe(403);
  });

  it('403s an SME running a command on someone else\'s computer', async () => {
    const res = await request(buildApp(SME))
      .post('/api/devbox/devbox-1111111111111111111111111111/command')
      .send({ command: 'ls' });
    expect(res.status).toBe(403);
  });

  it('403s an SME on a session id the registry has never seen', async () => {
    // The bypass this closes: /:sessionId routes take the id straight from the
    // path, so an unregistered one would skip the check entirely.
    const res = await request(buildApp(SME))
      .post('/api/devbox/devbox-9999999999999999999999999999/command')
      .send({ command: 'ls' });
    expect(res.status).toBe(403);
  });

  it('lets a fleet-wide role adopt an unregistered session id', async () => {
    const res = await request(buildApp({ role: 'hr-admin' }))
      .post('/api/devbox/devbox-9999999999999999999999999999/command')
      .send({ command: 'rm -rf /' });
    // Refused on the allowlist, not on ownership — it got past the access gate.
    expect(res.status).toBe(400);
  });

  it('adopting an unregistered session REGISTERS it, so the reaper can stop it', async () => {
    // The cost leak this closes: the fleet registry is in memory, so a
    // middleware restart drops every box while the AgentCore sessions keep
    // running. The reaper only iterates listBoxes(), and there is no AgentCore
    // API that enumerates live runtime sessions to reconcile against — so a
    // session the registry has forgotten was outside both the idle timeout and
    // the max-lifetime ceiling for good. Using it had to also reclaim it.
    const LOST = 'devbox-8888888888888888888888888888';
    expect(getBoxBySession(LOST)).toBeNull();

    await request(buildApp({ role: 'hr-admin' }))
      .post(`/api/devbox/${LOST}/command`)
      .send({ command: 'ls' });

    const adopted = getBoxBySession(LOST);
    expect(adopted).not.toBeNull();
    // Back under BOTH timers — that is the whole point of adopting it.
    const [decision] = decideReaping([adopted!], Date.now() + MAX_LIFETIME_MS + 1);
    expect(decision?.reason).toBe('max-lifetime');
  });

  it('refuses to charge a new computer to an initiative the SME is not on', async () => {
    const res = await request(buildApp(SME))
      .post('/api/devbox/boxes')
      .send({ sessionId: 'devbox-3333333333333333333333333333', projectId: 'p-not-mine' });
    expect(res.status).toBe(403);
  });

  it('charges a new computer to an initiative the SME is on, and stamps the owner', async () => {
    const res = await request(buildApp(SME))
      .post('/api/devbox/boxes')
      .send({ sessionId: 'devbox-3333333333333333333333333333', projectId: 'p-mine' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ projectId: 'p-mine', ownerId: 'u-nora' });
  });

  it('takes the owner from the session, never the body', async () => {
    const res = await request(buildApp(SME))
      .post('/api/devbox/boxes')
      .send({ sessionId: 'devbox-4444444444444444444444444444', ownerId: 'u-someone-else' });
    expect(res.body.ownerId).toBe('u-nora');
  });
});

// ─── 9. Status, shell URL, and removing a computer ───────────────────────────

describe('GET /api/devbox/status', () => {
  afterEach(() => _internal.setControlClient(null));

  it('reports the deployed runtime and its per-task model capability from the runtime env', async () => {
    const control = { send: jest.fn(async () => ({ environmentVariables: { ANTHROPIC_MODEL: 'us.anthropic.claude-haiku-4-5', DEVBOX_ALLOWED_MODELS: 'a, b' } })) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _internal.setControlClient(control as any);
    const res = await request(buildApp()).get('/api/devbox/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      deployed: true, runtimeArn: ARN, runtimeName: 'orgiq_devbox', workspace: '/mnt/workspace',
      defaultModel: 'us.anthropic.claude-haiku-4-5', allowedModels: ['a', 'b'], perTaskModel: true,
    });
    expect(Array.isArray(res.body.commandAllowlist)).toBe(true);
    expect(typeof res.body.fullExecEnabled).toBe('boolean');
    expect((control.send.mock.calls[0] as unknown[])[0]).toMatchObject({ input: { agentRuntimeId: 'orgiq_devbox-abc123' } });
  });

  it('does not promise model switching when the runtime env cannot be read', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _internal.setControlClient({ send: jest.fn(async () => { throw new Error('stale ARN'); }) } as any);
    const res = await request(buildApp()).get('/api/devbox/status');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deployed: true, defaultModel: null, allowedModels: [], perTaskModel: false });
  });

  it('offline (MOCK_AGENTCORE) reports a fake deployed runtime without any control-plane call', async () => {
    delete process.env['DEVBOX_RUNTIME_ARN'];
    process.env['MOCK_AGENTCORE'] = 'true';
    const control = { send: jest.fn(async () => ({})) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _internal.setControlClient(control as any);
    const res = await request(buildApp()).get('/api/devbox/status');
    expect(res.body.deployed).toBe(true);
    expect(res.body.runtimeArn).toMatch(/runtime\/orgiq_devbox-MOCK$/);
  });
});

describe('POST /api/devbox/:sessionId/shell-url', () => {
  const SME = { sub: 'u-nora', role: 'sme' as const };
  const THEIRS = 'devbox-1111111111111111111111111111';
  beforeEach(() => {
    _resetFleet();
    registerBox({ id: 'own', sessionId: SESSION, ownerId: 'u-nora' });
    registerBox({ id: 'theirs', sessionId: THEIRS, ownerId: 'u-eli' });
  });
  afterEach(() => _resetFleet());

  it('mints a mock-shell URL for the owner, with a stable per-session default shellId', async () => {
    process.env['MOCK_AGENTCORE'] = 'true';
    const res = await request(buildApp(SME)).post(`/api/devbox/${SESSION}/shell-url`).send({});
    expect(res.status).toBe(200);
    const shellId = `portal-${SESSION.slice(-12)}`;
    expect(res.body).toMatchObject({ url: `mock-shell://${SESSION}?shell=${shellId}`, shellId, mock: true });
  });

  it('403s an SME on someone else\'s computer and 400s a short id or a bad shellId', async () => {
    process.env['MOCK_AGENTCORE'] = 'true';
    expect((await request(buildApp(SME)).post(`/api/devbox/${THEIRS}/shell-url`).send({})).status).toBe(403);
    expect((await request(buildApp(SME)).post('/api/devbox/short/shell-url').send({})).status).toBe(400);
    const bad = await request(buildApp(SME)).post(`/api/devbox/${SESSION}/shell-url`).send({ shellId: 'has spaces' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/invalid shellId/);
  });

  it('503s honestly when no devbox runtime is deployed (real mode)', async () => {
    delete process.env['DEVBOX_RUNTIME_ARN'];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _internal.setControlClient({ send: jest.fn(async () => ({ agentRuntimes: [] })) } as any);
    try {
      const res = await request(buildApp(SME)).post(`/api/devbox/${SESSION}/shell-url`).send({});
      expect(res.status).toBe(503);
      expect(res.body.error).toMatch(/not deployed/);
    } finally { _internal.setControlClient(null); }
  });
});

describe('DELETE /api/devbox/boxes/:boxId', () => {
  const SME = { sub: 'u-nora', role: 'sme' as const };
  beforeEach(() => {
    _resetFleet();
    registerBox({ id: 'own', sessionId: SESSION, ownerId: 'u-nora' });
    registerBox({ id: 'theirs', sessionId: 'devbox-1111111111111111111111111111', ownerId: 'u-eli' });
  });
  afterEach(() => _resetFleet());

  it('stops the owner\'s runtime session and removes the computer from the fleet', async () => {
    const { calls } = mockDataClient(async () => ({}));
    const res = await request(buildApp(SME)).delete('/api/devbox/boxes/own');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ removed: true, boxId: 'own' });
    expect(calls[0]!.input).toMatchObject({ agentRuntimeArn: ARN, runtimeSessionId: SESSION });
    expect(getBox('own')).toBeNull();
    expect(getBoxBySession(SESSION)).toBeNull();
  });

  it('still removes the computer when the best-effort stop fails', async () => {
    mockDataClient(async () => { throw new Error('throttled'); });
    const res = await request(buildApp(SME)).delete('/api/devbox/boxes/own');
    expect(res.status).toBe(200);
    expect(getBox('own')).toBeNull();
  });

  it('403s an SME removing someone else\'s computer and leaves it in the fleet; 404s an unknown one', async () => {
    const { client } = mockDataClient(async () => ({}));
    const denied = await request(buildApp(SME)).delete('/api/devbox/boxes/theirs');
    expect(denied.status).toBe(403);
    expect(getBox('theirs')).not.toBeNull();
    expect(client.send).not.toHaveBeenCalled();
    const missing = await request(buildApp(SME)).delete('/api/devbox/boxes/nope');
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual({ error: 'computer not found' });
  });
});
