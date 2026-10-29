// DE-45: credentials out of shell strings.
//
// - The git-op builder puts the token in one payload field and nowhere else.
// - A clone through the entrypoint, against the fake microVM, sends NO shell
//   command at all; every command the mock records is free of
//   `x-access-token:`; the token is minted per run, scoped to the repo with
//   `contents: read`, and audited without the token.
// - A public repository mints nothing.
// - A mint refusal stops before the box is touched (no PAT fallback).
// - The legacy shell wrapper deletes its probe file.

import { mockDevboxClient, recordedShellCommands, recordedGitOps, clearDevboxRecordings } from '../../mock/devbox-shell.js';
import {
  buildGitOpPayload, cloneIntoBox, runDevboxGit, gitEntrypointEnabled, permissionsFor,
} from '../devbox-git.js';
import { LocalFakeTokenProvider, _setRepoTokenProvider, type RepoTokenProvider } from '../repo-token-provider.js';
import { runDevboxShell } from '../project-runner.js';
import { recordCredentialIssue } from '../../providers/credential-issues.js';

jest.mock('../../providers/credential-issues.js', () => ({ recordCredentialIssue: jest.fn(async () => undefined) }));
jest.mock('../../providers/spend-ledger.js', () => ({ recordAgentProjectRunSpend: jest.fn(async () => undefined) }));
jest.mock('../../providers/agent-projects.js', () => ({
  checkoutPath: (p: { repoFullName: string; workspacePath: string }) => `${p.workspacePath}/${p.repoFullName.split('/')[1]}`,
  // The legacy builder, as shaped in production: the token in the URL.
  buildCloneCommand: jest.fn(async (p: { repoFullName: string; workspacePath: string }) => ({
    command: `rm -rf /w/x && git clone --depth 50 https://x-access-token:LEGACYPAT@github.com/${p.repoFullName}.git ${p.workspacePath}/x`,
    redacted: 'redacted',
  })),
  finishRun: jest.fn(),
}));

const SESSION = 'devbox-0123456789abcdef0123456789abcdef';
const project = (connectionName: string | null) => ({
  id: 'ap-1', repoFullName: 'acme/widgets', connectionName, workspacePath: '/mnt/workspace',
}) as never;

let fake: LocalFakeTokenProvider;
beforeEach(() => {
  fake = new LocalFakeTokenProvider();
  _setRepoTokenProvider(fake);
  clearDevboxRecordings();
  (recordCredentialIssue as jest.Mock).mockClear();
});
afterAll(() => _setRepoTokenProvider(null));

describe('buildGitOpPayload', () => {
  it('carries the token in the token field only', () => {
    const token = 'ghs_SECRET_abcdef123';
    const payload = buildGitOpPayload({ op: 'clone', repo: 'acme/widgets', target: '/mnt/workspace/widgets' }, token);
    expect(payload['token']).toBe(token);
    const others = Object.entries(payload).filter(([k]) => k !== 'token').map(([, v]) => JSON.stringify(v));
    expect(others.join(' ')).not.toContain(token);
    expect(JSON.stringify(payload)).not.toMatch(/x-access-token:/);
  });

  it('validates before a token is minted for a bad op', () => {
    expect(() => buildGitOpPayload({ op: 'push', repo: 'acme/widgets', target: '/w' }, null)).toThrow(/branch/);
    expect(() => buildGitOpPayload({ op: 'clone', repo: '../etc', target: '/w' }, null)).toThrow(/owner\/name/);
    expect(() => buildGitOpPayload({ op: 'clone', repo: 'a/b', target: 'relative' }, null)).toThrow(/absolute/);
  });

  it('asks for read to clone and write + PRs to push', () => {
    expect(permissionsFor('clone')).toEqual({ contents: 'read' });
    expect(permissionsFor('push')).toEqual({ contents: 'write', pull_requests: 'write' });
  });
});

describe('cloneIntoBox through the entrypoint (fake microVM)', () => {
  it('mints a per-run read token, sends no shell command, and audits without the token', async () => {
    const out = await cloneIntoBox({
      client: mockDevboxClient(), arn: 'arn:devbox', sessionId: SESSION, project: project('gh-acme'),
      runRef: `clone:${SESSION}`, callerSub: 'u-1', useEntrypoint: true,
    });
    expect(out).toMatchObject({ ok: true, via: 'entrypoint', checkout: '/mnt/workspace/widgets' });
    expect(recordedShellCommands()).toEqual([]);
    expect(recordedGitOps()).toEqual([{ sessionId: SESSION, op: 'clone', repo: 'acme/widgets', target: '/mnt/workspace/widgets', authenticated: true }]);

    expect(fake.minted).toHaveLength(1);
    const minted = fake.minted[0]!;
    expect(minted).toMatchObject({ repoFullName: 'acme/widgets', perms: { contents: 'read' }, ctx: { runRef: `clone:${SESSION}`, callerSub: 'u-1' } });
    expect(JSON.stringify(out)).not.toContain(minted.token);

    expect(recordCredentialIssue).toHaveBeenCalledWith(expect.objectContaining({
      runRef: `clone:${SESSION}`, repo: 'acme/widgets', provider: 'local', permissions: { contents: 'read' }, callerSub: 'u-1',
    }));
    expect(JSON.stringify((recordCredentialIssue as jest.Mock).mock.calls)).not.toContain(minted.token);
  });

  it('a public repository mints nothing and clones unauthenticated', async () => {
    const out = await cloneIntoBox({
      client: mockDevboxClient(), arn: 'arn:devbox', sessionId: SESSION, project: project(null),
      runRef: 'clone:x', callerSub: null, useEntrypoint: true,
    });
    expect(out.ok).toBe(true);
    expect(fake.minted).toHaveLength(0);
    expect(recordedGitOps()[0]?.authenticated).toBe(false);
  });

  it('a mint refusal stops before the box is touched — no PAT fallback', async () => {
    const refusing: RepoTokenProvider = { kind: 'github-app', mintRepoToken: async () => { throw new Error('the GitHub App is not installed on acme'); } };
    _setRepoTokenProvider(refusing);
    const out = await cloneIntoBox({
      client: mockDevboxClient(), arn: 'arn:devbox', sessionId: SESSION, project: project('gh-acme'),
      runRef: 'clone:x', callerSub: null, useEntrypoint: true,
    });
    expect(out).toMatchObject({ ok: false, error: expect.stringMatching(/not installed/) });
    expect(recordedGitOps()).toEqual([]);
    expect(recordedShellCommands()).toEqual([]);
  });

  it('every shell command the mock receives on the legacy path is recorded, so the leak is visible', async () => {
    await cloneIntoBox({
      client: mockDevboxClient(), arn: 'arn:devbox', sessionId: SESSION, project: project('gh-acme'),
      runRef: 'clone:x', callerSub: null, useEntrypoint: false,
    });
    // The legacy builder still splices a PAT into the URL — exactly what the
    // entrypoint path removes. The recording is what makes that assertable.
    expect(recordedShellCommands().some((c) => /x-access-token:\S+/.test(c))).toBe(true);
  });
});

describe('runDevboxGit against an image without the entrypoint', () => {
  it('names the missing entrypoint instead of reporting a clean clone', async () => {
    const enc = new TextEncoder();
    const client = { send: async () => ({ response: (async function* () { yield enc.encode('data: {"agent":"devbox","error":"missing prompt"}\n'); })() }) };
    const r = await runDevboxGit(client as never, 'arn', SESSION, { op: 'clone', repo: 'acme/widgets', target: '/w/x' }, 'tok_12345678');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no git entrypoint/);
  });

  it('scrubs the token from a thrown transport error', async () => {
    const client = { send: async () => { throw new Error('boom tok_12345678 https://x:tok_12345678@github.com'); } };
    const r = await runDevboxGit(client as never, 'arn', SESSION, { op: 'clone', repo: 'acme/widgets', target: '/w/x' }, 'tok_12345678');
    expect(r.error).not.toContain('tok_12345678');
  });
});

describe('gitEntrypointEnabled', () => {
  it.each([
    [{}, false],
    [{ MOCK_AGENTCORE: 'true' }, true],
    [{ DEVBOX_GIT_ENTRYPOINT: 'on' }, true],
    [{ DEVBOX_GIT_ENTRYPOINT: 'off', MOCK_AGENTCORE: 'true' }, false],
  ])('%o → %s', (env, want) => expect(gitEntrypointEnabled(env as NodeJS.ProcessEnv)).toBe(want));
});

describe('the legacy shell wrapper', () => {
  it('deletes its probe file and keeps the probe\'s exit status', async () => {
    const sent: string[] = [];
    const client = { send: async (c: { input: { body: { command: string } } }) => { sent.push(c.input.body.command); return { stream: [] }; } };
    await runDevboxShell(client as never, 'arn', SESSION, 'git status');
    expect(sent[0]).toMatch(/\. \/tmp\/\.orgiq-probe < \/dev\/null; rc=\$\?; rm -f \/tmp\/\.orgiq-probe; exit \$rc/);
  });
});
