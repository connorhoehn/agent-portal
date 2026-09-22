// Mock stream-json generator for `routes/internal-devbox.ts`'s
// `POST /:sessionId/task`, active only under MOCK_AGENTCORE=true.
//
// Deliberately NOT `mockDevboxClient()` (mock/devbox-shell.ts). That client
// backs the PUBLIC `/api/devbox/:sessionId/task` route and several other
// callers (`lib/project-runner.ts`, `lib/sdlc-pipeline.ts`) that already
// depend on its exact event shapes and must keep working unmodified — see
// CLAUDE.md's "Keep whatever the mock client already does for the public
// route working". The chat agent loop (LOOP-BRIEF.md §2/§3) needs a
// genuinely different mock behaviour that has no analogue in that client:
//
//   - frames re-framed FLAT (`{ type: 'assistant', text, … }`, not nested
//     under `message.content[]`) — this is what platform-api's DevboxAgentClient
//     parses, and the re-framing is deliberate, not an accident of shape.
//   - `resume` grows a per-session cumulative context total, so a multi-step
//     pipeline loop can actually reach `contextBudgetTokens` and stop with
//     `'budget'`.
//   - the THIRD resumed task ends its `result` text with `DONE` on its own
//     last line, so the loop can also reach `'complete'` offline.
//
// A separate module, a separate Map of per-session state, and a separate
// test file — nothing here is reachable from the public devbox surface.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LoopMockUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface LoopMockFrame extends Record<string, unknown> {
  type: 'task_started' | 'assistant' | 'tool_use' | 'tool_result' | 'result';
  ts: string;
  mock: true;
}

/** Context tokens a fresh (non-resumed) task reports. */
const BASE_CONTEXT_TOKENS = 42_000;
/** How much cumulative context a single resumed task adds. Matches the
 *  "+35k per task" example in LOOP-BRIEF.md §3. */
const RESUME_INCREMENT_TOKENS = 35_000;
/** The Nth resumed call (1-indexed) whose result text ends with DONE. */
const DONE_ON_RESUME_COUNT = 3;

interface SessionState {
  /** How many times `resume: true` has been honoured for this session. */
  resumeCount: number;
  /** Running total of `usage.prompt` (input+cache_creation+cache_read+output)
   *  across the session's calls — the number a real budget check compares
   *  against `contextBudgetTokens`. */
  cumulativeContext: number;
}

const sessions = new Map<string, SessionState>();

/** Test hook — wipe per-session resume/context tracking between suites. */
export function _resetLoopMock(): void {
  sessions.clear();
}

function now(): string {
  return new Date().toISOString();
}

// ─── Mock workspace ─────────────────────────────────────────────────────────
//
// `routes/internal-devbox.ts`'s `GET /:sessionId/files[/:fileId]` (LOOP-BRIEF.md
// §7) must return true bytes even under MOCK_AGENTCORE=true — never invented
// file names. So the mock loop writes a REAL `notes.md` here, under a
// per-session temp dir, containing the mock's own assistant text
// (`narration` + `summaryText` below), appended as the loop iterates.
// `lib/devbox-files.ts` lists/reads directly off this directory in mock mode.

/** Per-session temp workspace the mock loop writes into. Exported so
 *  `lib/devbox-files.ts` can list/read the same directory, and so
 *  `routes/internal-devbox.ts` can clear it on `DELETE /:sessionId`. */
export function mockWorkspaceDir(sessionId: string): string {
  return path.join(os.tmpdir(), 'devbox-mock', sessionId);
}

function notesPath(sessionId: string): string {
  return path.join(mockWorkspaceDir(sessionId), 'notes.md');
}

/** Removes a session's mock workspace. Called from `DELETE /:sessionId` in
 *  mock mode, mirroring the real transport stopping the microVM (and its
 *  workspace) on session stop. Safe to call for a session that never wrote
 *  anything. */
export function clearMockWorkspace(sessionId: string): void {
  fs.rmSync(mockWorkspaceDir(sessionId), { recursive: true, force: true });
}

/** Writes (fresh task) or appends (resumed task) this iteration's assistant
 *  text to the session's `notes.md` — a fresh task starts the file over,
 *  matching the same "fresh resets tracking" rule `buildLoopMockFrames`
 *  already applies to `cumulativeContext`. */
function writeMockNotes(
  sessionId: string,
  opts: { fresh: boolean; resumeCount: number; narration: string; summaryText: string },
): void {
  const dir = mockWorkspaceDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const entry = `## Iteration ${opts.resumeCount + 1} — ${now()}\n\n${opts.narration}\n\n${opts.summaryText}\n`;
  if (opts.fresh) {
    fs.writeFileSync(notesPath(sessionId), `# Notes — ${sessionId}\n\n${entry}`);
  } else {
    fs.appendFileSync(notesPath(sessionId), `\n${entry}`);
  }
}

function usageFor(fresh: boolean, priorCumulative: number): LoopMockUsage {
  if (fresh) {
    return {
      input_tokens: 1_500,
      output_tokens: 900,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: BASE_CONTEXT_TOKENS - 1_500 - 900,
    };
  }
  // Re-reading the whole prior conversation from cache, plus genuinely new
  // tokens for this turn — split so input+cache_creation+output sums to
  // exactly RESUME_INCREMENT_TOKENS, keeping the "+35k per task" honest.
  return {
    input_tokens: 400,
    output_tokens: 1_200,
    cache_read_input_tokens: priorCumulative,
    cache_creation_input_tokens: RESUME_INCREMENT_TOKENS - 400 - 1_200,
  };
}

/**
 * Build one task's worth of re-framed mock stream-json frames: `task_started`
 * (fleet-log only, mirroring the real route's own convention — see
 * `routes/devbox.ts::runTaskAndForward`), one or more `assistant` text
 * frames, one `tool_use` + `tool_result` pair, then `result` carrying
 * `usage`. Every frame carries `mock: true`.
 *
 * `resume` is honoured per `sessionId`: the first call for a session (or any
 * call with `resume: false`) resets tracking to a fresh task; each
 * `resume: true` call after that grows the session's cumulative context by
 * `RESUME_INCREMENT_TOKENS` and counts toward `DONE_ON_RESUME_COUNT`.
 */
export function buildLoopMockFrames(opts: {
  sessionId: string; prompt: string; resume: boolean; model?: string;
}): LoopMockFrame[] {
  const { sessionId, prompt, resume, model } = opts;
  const priorState = sessions.get(sessionId);
  const fresh = !resume || !priorState;

  const state: SessionState = fresh
    ? { resumeCount: 0, cumulativeContext: BASE_CONTEXT_TOKENS }
    : { resumeCount: priorState.resumeCount + 1, cumulativeContext: priorState.cumulativeContext + RESUME_INCREMENT_TOKENS };
  sessions.set(sessionId, state);

  const usage = usageFor(fresh, fresh ? 0 : priorState!.cumulativeContext);
  const isDone = !fresh && state.resumeCount === DONE_ON_RESUME_COUNT;
  const resolvedModel = model ?? 'sonnet';

  const readsCode = /read|inspect|review|look at/i.test(prompt);
  const toolName = readsCode ? 'Read' : 'Bash';
  const toolInput = readsCode
    ? { file_path: '/mnt/workspace/README.md' }
    : { command: 'ls -la /mnt/workspace' };
  const toolId = `toolu_mock_${sessionId.slice(-6)}_${state.resumeCount}`;
  const toolOutput = readsCode
    ? '# Mock workspace\n\nNothing real is deployed here (MOCK_AGENTCORE=true).'
    : 'total 0\ndrwxr-xr-x  2 orgiq orgiq 64 Jan  1 00:00 .\ndrwxr-xr-x  2 orgiq orgiq 64 Jan  1 00:00 ..';

  const narration = fresh
    ? `Starting work on: ${prompt.slice(0, 160)}`
    : `Resuming (iteration ${state.resumeCount + 1}). Continuing the task.`;
  const summaryText = isDone
    ? `Task complete: ${prompt.slice(0, 120)}.\nDONE`
    : `Made progress on the task; more work remains.`;

  writeMockNotes(sessionId, { fresh, resumeCount: state.resumeCount, narration, summaryText });

  return [
    { type: 'task_started', prompt, model: resolvedModel, mock: true, ts: now() },
    { type: 'assistant', text: narration, model: resolvedModel, mock: true, ts: now() },
    { type: 'tool_use', id: toolId, name: toolName, input: toolInput, mock: true, ts: now() },
    { type: 'tool_result', tool_use_id: toolId, output: toolOutput, mock: true, ts: now() },
    {
      type: 'result',
      subtype: 'success',
      num_turns: state.resumeCount + 1,
      model: resolvedModel,
      result: summaryText,
      usage,
      mock: true,
      ts: now(),
    },
  ];
}

/**
 * Pace between frames. `MOCK_DEVBOX_PACE_MS` overrides; 0 under jest
 * (NODE_ENV=test) so suites stay instant, a small default elsewhere so a
 * running loop visibly streams rather than resolving in one event-loop turn —
 * same convention as `mock/devbox-shell.ts::devboxPaceMs`.
 */
export function loopMockPaceMs(): number {
  const raw = process.env['MOCK_DEVBOX_PACE_MS'];
  if (raw !== undefined && raw !== '') return Math.max(0, Number(raw) || 0);
  return process.env['NODE_ENV'] === 'test' ? 0 : 300;
}
