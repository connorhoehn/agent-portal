// A devbox that answers, with no microVM behind it.
//
// `lib/devbox-arn.ts` hands every caller one `BedrockAgentCoreClient`, and two
// commands go through it: `InvokeAgentRuntimeCommandCommand` (run a shell
// command in the session, stream stdout back) and `InvokeAgentRuntimeCommand`
// (run a Claude Code task in the session, stream its SSE events back). This
// module is a stand-in for both, over `mock/devbox-workspace.ts`.
//
// WHY A FAKE CLIENT RATHER THAN A MOCK BRANCH IN EACH CALLER. The callers are
// `lib/project-runner.ts` and `lib/sdlc-pipeline.ts`, and what they do with
// the devbox is the whole governance pipeline: snapshot the tree, run the
// task, measure the tree, capture the diff, commit it, hand it to the
// reviewer, run the gates, roll back a blocked change. Branching inside each
// of them would mean an offline pipeline that is a *different* pipeline —
// different sequencing, different failure handling, and no test of the real
// one. Replacing the transport instead means every line of that code runs
// exactly as it does in production, and only the sandbox is imaginary.
//
// AN UNKNOWN COMMAND IS AN ERROR, LOUDLY. Every caller treats a leading
// `fatal:` as a git failure, so an unrecognised probe surfaces as one instead
// of as an empty string — which `readWorkingTree` would read as "the tree is
// clean", the single most misleading answer this module could give.

import type { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import {
  IDLE_RUN_COST_USD, commitPending, hasCommit, pendingStat, porcelain,
  resetToParent, selectWorkProduct, stageWork, workspaceFor,
} from './devbox-workspace.js';

/** The `sh -c '... echo <b64> | base64 -d > /tmp/.orgiq-probe ...'` wrapper runDevboxShell builds. */
function unwrapProbe(command: string): string {
  const m = /echo ([A-Za-z0-9+/=]+) \| base64 -d > \/tmp\/\.orgiq-probe/.exec(command);
  if (!m?.[1]) return command;
  return Buffer.from(m[1], 'base64').toString('utf8');
}

/**
 * Run one shell command against a session's workspace.
 *
 * Ordered most specific first: the capture probe and the commit probe both
 * contain the word `diff`/`add -A`, so a looser match earlier would answer the
 * wrong question with a straight face.
 */
export function runMockShell(sessionId: string, wrapped: string): string {
  const cmd = unwrapProbe(wrapped);
  const ws = workspaceFor(sessionId);

  // The clone, which is how a workspace comes into existence on BOTH paths.
  // Without it `ensureWorkspace` (lib/bot-runner.ts) fell through to the
  // unsupported-command `fatal:` below and every marketplace dispatch 503'd
  // with "clone failed" offline — the run never started, so nothing downstream
  // of it could be exercised either. The command ends in a `git log --oneline
  // -1` verify (providers/agent-projects.ts::buildCloneCommand), so that one
  // line is what a successful clone streams back; anything matching
  // CLONE_FAILURE here would be read as a broken checkout.
  if (/git clone /.test(cmd)) {
    return `${ws.commits[0]!.slice(0, 7)} Initial import\n`;
  }

  const catFile = /cat-file -e ([0-9a-f]{40})/.exec(cmd);
  if (catFile) return hasCommit(sessionId, catFile[1]!) ? '__OK__\n' : '__MISSING__\n';

  const reset = /reset -q --hard ([0-9a-f]{40})~1/.exec(cmd);
  if (reset) { resetToParent(sessionId, reset[1]!); return ''; }

  if (/commit -q -m/.test(cmd)) {
    const sha = commitPending(sessionId);
    // Real git says this and exits non-zero, and `commitCapture` treats a
    // non-sha as "no commit" and falls back to working-tree delivery — which
    // is the behaviour a clean tree should get.
    return sha ? `${sha}\n` : 'nothing to commit, working tree clean\n';
  }

  if (/diff --stat/.test(cmd)) return `${pendingStat(ws)}\n`;
  if (/status --porcelain/.test(cmd)) {
    const lines = porcelain(ws);
    return lines ? `${lines}\n` : '';
  }
  if (/\bdiff\b/.test(cmd)) return ws.pending?.diff ?? '';

  return `fatal: mock devbox: unsupported command (${cmd.slice(0, 120)})\n`;
}

/**
 * Run one agent task against a session's workspace.
 *
 * Emits the same event stream `executeDevboxTask` parses out of a real run —
 * assistant text, tool_use blocks, a `result` with the run's own verdict and
 * cost, then `devbox_end` — and leaves the selected work product uncommitted
 * in the tree, which is what makes the run "change code" as far as
 * `readWorkingTree` is concerned.
 */
export function runMockTask(sessionId: string, prompt: string): string[] {
  const product = selectWorkProduct(prompt);
  const events: Record<string, unknown>[] = [];

  if (!product) {
    events.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'I read the repository and found nothing to change for this task.' }] } });
    events.push({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: IDLE_RUN_COST_USD, result: 'No change was needed.' });
    events.push({ type: 'devbox_end', exit_code: 0 });
  } else {
    stageWork(sessionId, product.diff);
    events.push({ type: 'assistant', message: { content: [{ type: 'text', text: `Working in the checkout. ${product.summary}` }] } });
    for (const call of product.toolCalls) {
      events.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: call.name, input: { file_path: call.target } }] } });
    }
    events.push({
      type: 'result', subtype: 'success',
      num_turns: product.toolCalls.length + 1,
      total_cost_usd: product.costUsd,
      result: product.summary,
    });
    events.push({ type: 'devbox_end', exit_code: 0 });
  }
  return events.map((e) => `data: ${JSON.stringify(e)}\n`);
}

async function* shellStream(out: string): AsyncGenerator<{ chunk: { contentDelta: { stdout: string } } }> {
  yield { chunk: { contentDelta: { stdout: out } } };
}

/**
 * Milliseconds between a mock run's events.
 *
 * `MOCK_DEVBOX_PACE_MS` overrides; default 900ms in development and 0 under
 * jest so the suites stay instant. A real devbox task takes a minute or two,
 * and yielding every event in one tick made a run begin and end inside the
 * same event-loop turn — so a computer in the lab never *showed* as running,
 * it simply had a finished run attached to it. The pace is per event, so the
 * five-ish events of a typical work product run for a few seconds.
 */
function devboxPaceMs(): number {
  const raw = process.env['MOCK_DEVBOX_PACE_MS'];
  if (raw !== undefined && raw !== '') return Math.max(0, Number(raw) || 0);
  return process.env['NODE_ENV'] === 'test' ? 0 : 900;
}

async function* taskStream(lines: string[]): AsyncGenerator<Uint8Array> {
  const enc = new TextEncoder();
  const pace = devboxPaceMs();
  for (const line of lines) {
    if (pace > 0) await new Promise<void>((r) => { const t = setTimeout(r, pace); t.unref?.(); });
    yield enc.encode(line);
  }
}

/**
 * A `BedrockAgentCoreClient` that never leaves the process.
 *
 * Cast rather than subclassed: the SDK client's surface is large and none of
 * it beyond `send` is reachable from the devbox callers, so implementing the
 * rest would be dead code pretending to be a contract.
 */
export function mockDevboxClient(): BedrockAgentCoreClient {
  const client = {
    async send(command: unknown): Promise<unknown> {
      const input = ((command as { input?: Record<string, unknown> }).input ?? {}) as Record<string, unknown>;
      const sessionId = String(input['runtimeSessionId'] ?? 'mock-session');

      // The shell command API — `body: { command, timeout }`.
      const body = input['body'] as { command?: string } | undefined;
      if (body && typeof body.command === 'string') {
        return { stream: shellStream(runMockShell(sessionId, body.command)) };
      }

      // The agent task API — `payload` is UTF-8 JSON.
      const payload = input['payload'] as Uint8Array | undefined;
      if (payload) {
        let prompt = '';
        try { prompt = String((JSON.parse(Buffer.from(payload).toString('utf8')) as { prompt?: unknown }).prompt ?? ''); }
        catch { prompt = ''; }
        return { response: taskStream(runMockTask(sessionId, prompt)) };
      }

      throw new Error('mock devbox: unrecognised runtime command');
    },
    destroy(): void { /* nothing to tear down */ },
  };
  return client as unknown as BedrockAgentCoreClient;
}
