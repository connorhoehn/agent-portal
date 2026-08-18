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

import express from 'express';
import request from 'supertest';
import { devboxRouter, _internal, validateCommand, buildContainerCommand, validateCwd, CWD_MARKER } from '../devbox.js';

const SESSION = 'devbox-0123456789abcdef0123456789abcdef';
const ARN = 'arn:aws:bedrock-agentcore:us-east-1:111122223333:runtime/orgiq_devbox-abc123';

function buildApp() {
  const app = express();
  app.use(express.json());
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
  it('stops the runtime session', async () => {
    const { calls } = mockDataClient(async () => ({}));
    const res = await request(buildApp()).delete(`/api/devbox/${SESSION}`);
    expect(res.status).toBe(200);
    expect(res.body.stopped).toBe(true);

    const input = calls[0]!.input as { agentRuntimeArn: string; runtimeSessionId: string };
    expect(input.agentRuntimeArn).toBe(ARN);
    expect(input.runtimeSessionId).toBe(SESSION);
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
