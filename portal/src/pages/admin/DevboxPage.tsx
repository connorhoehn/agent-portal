import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { PageSection, Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { Markdown } from '../../components/Markdown';
import {
  createBox,
  loadBoxes,
  syncBoxes,
  onBoxesChanged,
  removeBox,
  type DevboxBox,
  type BoxStatus,
} from '../../lib/devboxRegistry';
import {
  toastPending,
  toastUpdate,
  toastSuccess,
  toastError,
} from '../../lib/toastStore';

// ─── Types ────────────────────────────────────────────────────────────────────

interface DevboxStatus {
  deployed: boolean;
  runtimeArn: string | null;
  runtimeName: string;
  commandAllowlist: string[];
}

/** One entry in the task execution timeline. */
type TimelineItem =
  | { id: string; kind: 'meta'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'tool'; name: string; summary: string; detail?: string; output?: string; isError?: boolean }
  | { id: string; kind: 'result'; subtype: string; turns: number; durationMs: number; costUsd: number; text?: string }
  | { id: string; kind: 'end'; exitCode: number | null; timedOut: boolean; stderr?: string }
  | { id: string; kind: 'error'; text: string };

interface ConsoleLine {
  id: string;
  kind: 'cmd' | 'stdout' | 'stderr' | 'exit' | 'err';
  text: string;
}

// ─── SSE helper (POST + fetch/ReadableStream, per repo convention) ───────────

async function readSse(
  url: string,
  body: unknown,
  onEvent: (ev: Record<string, unknown>) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = ((await res.json()) as { error?: string }).error ?? msg; } catch { /* keep status */ }
    throw new Error(msg);
  }
  if (!res.body) throw new Error('empty response body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() ?? '';
    for (const part of parts) {
      const line = part.trim();
      if (!line.startsWith('data:')) continue;
      try {
        const ev = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
        onEvent(ev);
      } catch { /* partial / non-JSON frame — skip */ }
    }
  }
}

// ─── Rendering helpers ───────────────────────────────────────────────────────

const mono = 'font-["Fira_Code","Cascadia_Code","JetBrains_Mono",monospace]';

function toolSummary(name: string, input: Record<string, unknown>): { summary: string; detail?: string } {
  if (name === 'Bash') {
    return { summary: String(input['command'] ?? ''), detail: input['description'] ? String(input['description']) : undefined };
  }
  if (name === 'Write' || name === 'Edit' || name === 'Read' || name === 'NotebookEdit') {
    return { summary: String(input['file_path'] ?? input['notebook_path'] ?? '') };
  }
  const json = JSON.stringify(input);
  return { summary: json.length > 120 ? json.slice(0, 120) + '…' : json };
}

function toolIcon(name: string): string {
  if (name === 'Bash') return '$';
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') return '✎';
  if (name === 'Read' || name === 'Glob' || name === 'Grep') return '⌕';
  return '⚙';
}

/** stream-json tool_result content → plain text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n');
  }
  return content == null ? '' : JSON.stringify(content);
}

const WATCH_INTERVAL_MS = 5000;

// Herd status → dot color. `waiting` = the last run ended by asking the
// operator a question; `running` pulses.
const STATUS_DOT: Record<BoxStatus, string> = {
  idle: 'bg-success',
  running: 'bg-primary',
  waiting: 'bg-warning',
  stopped: 'bg-text-tertiary',
  error: 'bg-danger',
};

const STATUS_LABEL: Record<BoxStatus, string> = {
  idle: 'idle',
  running: 'running',
  waiting: 'waiting for feedback',
  stopped: 'stopped',
  error: 'error',
};

// Commands that read stdin forever when given no file argument — inside the
// microVM there is no interactive stdin, so a bare `cat` just hangs until the
// server times out and the console looks dead. Catch them client-side.
const STDIN_WAITERS = new Set(['cat', 'head', 'tail', 'wc', 'tee']);

function stdinTrapHint(text: string): string | null {
  if (!STDIN_WAITERS.has(text)) return null;
  return `'${text}' needs a file argument — bare '${text}' waits on stdin forever in the microVM. Try '${text} notes.md'.`;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DevboxPage() {
  const { data: status, error: statusError } = useFetch<DevboxStatus>('/api/devbox/status');
  const [searchParams, setSearchParams] = useSearchParams();

  // ── Box registry — server fleet is the source of truth ─────────────────────
  // Mirror renders instantly; syncBoxes reconciles with the middleware (and
  // re-adopts boxes after a middleware restart). Poll keeps status dots live.
  const [boxes, setBoxes] = useState<DevboxBox[]>(() => loadBoxes());
  useEffect(() => onBoxesChanged(() => setBoxes(loadBoxes())), []);
  useEffect(() => {
    let cancelled = false;
    const sync = () => void syncBoxes().then((b) => { if (!cancelled) setBoxes(b); }).catch(() => { /* offline — mirror stands */ });
    sync();
    const interval = setInterval(sync, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const boxParam = searchParams.get('box');
  const activeBox = boxes.find((b) => b.id === boxParam) ?? boxes[0] ?? null;

  const selectBox = useCallback((id: string) => {
    setSearchParams((prev) => { prev.set('box', id); return prev; }, { replace: true });
  }, [setSearchParams]);

  // ── Per-box streams (in-memory; switching boxes preserves each stream) ─────
  const [timelines, setTimelines] = useState<Record<string, TimelineItem[]>>({});
  const [consoles, setConsoles] = useState<Record<string, ConsoleLine[]>>({});
  const timeline = activeBox ? (timelines[activeBox.id] ?? []) : [];
  const consoleLines = activeBox ? (consoles[activeBox.id] ?? []) : [];

  const pushTimeline = useCallback((boxId: string, updater: (prev: TimelineItem[]) => TimelineItem[]) => {
    setTimelines((all) => ({ ...all, [boxId]: updater(all[boxId] ?? []) }));
  }, []);
  const pushConsole = useCallback((boxId: string, line: ConsoleLine) => {
    setConsoles((all) => ({ ...all, [boxId]: [...(all[boxId] ?? []), line] }));
  }, []);

  const [prompt, setPrompt] = useState('');
  const [resume, setResume] = useState(true);
  const [taskRunning, setTaskRunning] = useState(false);
  const [cmd, setCmd] = useState('');
  const [cmdRunning, setCmdRunning] = useState(false);
  const [watching, setWatching] = useState(false);
  const watchCmdRef = useRef('');

  const idRef = useRef(0);
  const nextId = () => String(++idRef.current);
  const timelineRef = useRef<HTMLDivElement>(null);
  const consoleRef = useRef<HTMLDivElement>(null);

  // Auto-scroll both streams as events land.
  useEffect(() => { timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight }); }, [timeline]);
  useEffect(() => { consoleRef.current?.scrollTo({ top: consoleRef.current.scrollHeight }); }, [consoleLines]);

  const [provisioning, setProvisioning] = useState(false);

  /** Mint a session with live toast feedback — shared by + new and auto-provision. */
  async function provisionBox(): Promise<DevboxBox> {
    const label = `devbox-${loadBoxes().length + 1}`;
    setProvisioning(true);
    const tid = toastPending(`Provisioning ${label}`, 'minting microVM runtime session…');
    try {
      const box = await createBox();
      toastUpdate(tid, { detail: `session …${box.sessionId.slice(-8)} · mounting /mnt/workspace` });
      toastSuccess(tid, `${box.label} ready`, `microVM session live · workspace persists across restarts`);
      selectBox(box.id);
      return box;
    } catch (err) {
      toastError(tid, `Provisioning failed`, (err as Error).message);
      throw err;
    } finally {
      setProvisioning(false);
    }
  }

  async function ensureBox(): Promise<DevboxBox> {
    if (activeBox) return activeBox;
    return provisionBox();
  }

  function forgetBox(id: string) {
    void removeBox(id).then(() => {
      if (activeBox?.id === id) {
        const rest = loadBoxes();
        if (rest[0]) selectBox(rest[0].id);
      }
    });
  }

  // ── Live tail — the timeline's single source of truth ──────────────────────
  // Every task event is teed server-side into the box's event log; this SSE
  // subscription replays the buffer then streams live. That means the timeline
  // survives reloads, and shows runs started by OTHER clients (curl, notebook,
  // a queue dispatcher) — the herd's read-only observation mode.
  useEffect(() => {
    const boxId = activeBox?.id;
    if (!boxId) return;
    const es = new EventSource(`/api/devbox/boxes/${encodeURIComponent(boxId)}/tail`);
    es.onopen = () => {
      // Replay rebuilds the full history — clear so reconnects don't duplicate.
      setTimelines((all) => ({ ...all, [boxId]: [] }));
    };
    es.onmessage = (evt: MessageEvent) => {
      try {
        handleTaskEvent(boxId, JSON.parse(evt.data) as Record<string, unknown>);
      } catch { /* non-JSON frame — skip */ }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBox?.id]);

  async function stopSession() {
    if (!activeBox) return;
    const tid = toastPending(`Stopping ${activeBox.label}`, 'sending StopRuntimeSession…');
    try {
      const res = await fetch(`/api/devbox/${activeBox.sessionId}`, { method: 'DELETE', credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      toastSuccess(tid, `${activeBox.label} stopped`, 'workspace persists — next task or command resumes it');
      pushTimeline(activeBox.id, (prev) => [...prev, { id: nextId(), kind: 'meta', text: 'session stopped — workspace persists; next invoke resumes it' }]);
    } catch (err) {
      toastError(tid, `Stop failed`, (err as Error).message);
    }
  }

  // ── Task mode: Claude Code run, rendered as an execution timeline ──────────

  // Live progress for the task toast: tool-call count + last tool, updated on
  // every stream event so the toast reads like a heartbeat.
  const taskProgressRef = useRef<{ toastId: string; tools: number; startedAt: number; result?: { turns: number; durationMs: number; costUsd: number } } | null>(null);

  function handleTaskEvent(boxId: string, ev: Record<string, unknown>) {
    const type = ev['type'];
    if (type === 'task_started') {
      pushTimeline(boxId, (prev) => [...prev, { id: nextId(), kind: 'meta', text: `▶ task: ${String(ev['prompt'] ?? '')}` }]);
    } else if (type === 'devbox_start') {
      const persistent = ev['workspace_persistent'] ? 'persistent' : 'EPHEMERAL — no session storage mount!';
      pushTimeline(boxId, (prev) => [...prev, {
        id: nextId(), kind: 'meta',
        text: `workspace ${String(ev['workspace'])} [${persistent}] · ${String(ev['model'])}`,
      }]);
    } else if (type === 'assistant') {
      const content = ((ev['message'] as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
      for (const block of content) {
        if (block['type'] === 'text' && String(block['text'] ?? '').trim()) {
          pushTimeline(boxId, (prev) => [...prev, { id: nextId(), kind: 'text', text: String(block['text']) }]);
        } else if (block['type'] === 'tool_use') {
          const name = String(block['name'] ?? 'tool');
          const { summary, detail } = toolSummary(name, (block['input'] ?? {}) as Record<string, unknown>);
          // Keyed by the tool_use id so the matching tool_result attaches below.
          pushTimeline(boxId, (prev) => [...prev, { id: String(block['id'] ?? nextId()), kind: 'tool', name, summary, detail }]);
          // Heartbeat the task toast with live tool activity.
          const p = taskProgressRef.current;
          if (p) {
            p.tools += 1;
            const elapsed = Math.round((Date.now() - p.startedAt) / 1000);
            toastUpdate(p.toastId, { detail: `${p.tools} tool ${p.tools === 1 ? 'call' : 'calls'} · ${elapsed}s · ${name}: ${summary.slice(0, 48)}` });
          }
        }
      }
    } else if (type === 'user') {
      // tool_result events — attach output to the matching execution card.
      const content = ((ev['message'] as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
      for (const block of content) {
        if (block['type'] !== 'tool_result') continue;
        const target = String(block['tool_use_id'] ?? '');
        const output = resultText(block['content']).slice(0, 4000);
        const isError = Boolean(block['is_error']);
        pushTimeline(boxId, (prev) => prev.map((item) =>
          item.kind === 'tool' && item.id === target ? { ...item, output, isError } : item,
        ));
      }
    } else if (type === 'result') {
      const turns = Number(ev['num_turns'] ?? 0);
      const durationMs = Number(ev['duration_ms'] ?? 0);
      const costUsd = Number(ev['total_cost_usd'] ?? 0);
      if (taskProgressRef.current) taskProgressRef.current.result = { turns, durationMs, costUsd };
      pushTimeline(boxId, (prev) => [...prev, {
        id: nextId(), kind: 'result',
        subtype: String(ev['subtype'] ?? ''),
        turns, durationMs, costUsd,
        text: typeof ev['result'] === 'string' ? (ev['result'] as string) : undefined,
      }]);
    } else if (type === 'devbox_end') {
      pushTimeline(boxId, (prev) => [...prev, {
        id: nextId(), kind: 'end',
        exitCode: (ev['exit_code'] ?? null) as number | null,
        timedOut: Boolean(ev['timed_out']),
        stderr: ev['stderr'] ? String(ev['stderr']) : undefined,
      }]);
    } else if (type === 'devbox_error') {
      pushTimeline(boxId, (prev) => [...prev, { id: nextId(), kind: 'error', text: String(ev['error'] ?? 'unknown error') }]);
    }
  }

  async function runTask() {
    const text = prompt.trim();
    if (!text || taskRunning) return;
    setTaskRunning(true);
    let toastId: string | null = null;
    try {
      const box = await ensureBox();
      toastId = toastPending(`Claude Code working in ${box.label}`, 'starting task in the microVM…');
      taskProgressRef.current = { toastId, tools: 0, startedAt: Date.now() };
      // Timeline rendering comes from the server tail subscription (single
      // source of truth) — this POST stream only anchors the completion toast.
      await readSse(`/api/devbox/${box.sessionId}/task`, { prompt: text, resume }, (ev) => {
        if (ev['type'] === 'result' && taskProgressRef.current) {
          taskProgressRef.current.result = {
            turns: Number(ev['num_turns'] ?? 0),
            durationMs: Number(ev['duration_ms'] ?? 0),
            costUsd: Number(ev['total_cost_usd'] ?? 0),
          };
        }
      });
      const r = taskProgressRef.current?.result;
      toastSuccess(
        toastId,
        `Task complete in ${box.label}`,
        r ? `${r.turns} turns · ${(r.durationMs / 1000).toFixed(0)}s · $${r.costUsd.toFixed(4)}` : undefined,
      );
      setPrompt('');
    } catch (err) {
      if (toastId) toastError(toastId, 'Task failed', (err as Error).message);
      if (activeBox) pushTimeline(activeBox.id, (prev) => [...prev, { id: nextId(), kind: 'error', text: (err as Error).message }]);
    } finally {
      taskProgressRef.current = null;
      setTaskRunning(false);
    }
  }

  // ── Command mode: allowlisted shell proxied into the microVM ───────────────

  const runCommand = useCallback(async (command: string, opts?: { silent?: boolean; snapshot?: boolean }) => {
    const text = command.trim();
    if (!text || cmdRunning) return;
    const trap = stdinTrapHint(text);
    if (trap) {
      if (activeBox) pushConsole(activeBox.id, { id: nextId(), kind: 'err', text: trap });
      else toastError(null, 'Command needs an argument', trap);
      return;
    }
    setCmdRunning(true);
    const box = await (async () => {
      if (activeBox) return activeBox;
      const tid = toastPending('Provisioning devbox', 'minting microVM runtime session…');
      try {
        const b = await createBox();
        toastSuccess(tid, `${b.label} ready`, 'microVM session live');
        selectBox(b.id);
        return b;
      } catch (err) {
        toastError(tid, 'Provisioning failed', (err as Error).message);
        throw err;
      }
    })();
    if (!opts?.silent) pushConsole(box.id, { id: nextId(), kind: 'cmd', text });
    // Snapshot mode (watch ticks): timestamped separator so each 5s pass is
    // visually distinct in the terminal, plus an explicit no-output marker —
    // otherwise a quiet command (e.g. `cat` with no args) looks like watch died.
    if (opts?.snapshot) {
      pushConsole(box.id, { id: nextId(), kind: 'exit', text: `── ${new Date().toLocaleTimeString()} ──` });
    }
    let sawOutput = false;
    try {
      await readSse(`/api/devbox/${box.sessionId}/command`, { command: text }, (ev) => {
        const type = ev['type'];
        if (type === 'stdout') { sawOutput = true; pushConsole(box.id, { id: nextId(), kind: 'stdout', text: String(ev['text']) }); }
        else if (type === 'stderr') { sawOutput = true; pushConsole(box.id, { id: nextId(), kind: 'stderr', text: String(ev['text']) }); }
        else if (type === 'exit' && !opts?.silent) pushConsole(box.id, { id: nextId(), kind: 'exit', text: `exit ${String(ev['exitCode'])} — ${String(ev['status'] ?? '')}` });
        else if (type === 'devbox_error') { sawOutput = true; pushConsole(box.id, { id: nextId(), kind: 'err', text: String(ev['error']) }); }
      });
      if (opts?.snapshot && !sawOutput) {
        pushConsole(box.id, { id: nextId(), kind: 'exit', text: '(no output)' });
      }
    } catch (err) {
      pushConsole(box.id, { id: nextId(), kind: 'err', text: (err as Error).message });
      if (!opts?.silent) toastError(null, 'Command failed', (err as Error).message);
    } finally {
      setCmdRunning(false);
    }
  }, [activeBox, cmdRunning, pushConsole, selectBox]);

  // Watch mode — "tail a devbox": re-run the watch command on an interval so
  // you can observe a workspace another actor (a task, a notebook, an
  // orchestrator) is mutating. Deterministic command mode, zero LLM cost.
  useEffect(() => {
    if (!watching) return;
    const tick = () => {
      if (!cmdRunning && watchCmdRef.current) {
        void runCommand(watchCmdRef.current, { silent: true, snapshot: true });
      }
    };
    const interval = setInterval(tick, WATCH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [watching, cmdRunning, runCommand]);

  function toggleWatch() {
    if (watching) { setWatching(false); return; }
    // Empty input → sensible default so the button is never a dead end.
    const text = cmd.trim() || 'ls -la';
    const trap = stdinTrapHint(text);
    if (trap) {
      if (activeBox) pushConsole(activeBox.id, { id: nextId(), kind: 'err', text: trap });
      else toastError(null, 'Command needs an argument', trap);
      return;
    }
    watchCmdRef.current = text;
    if (activeBox) {
      pushConsole(activeBox.id, { id: nextId(), kind: 'cmd', text: `watch(${WATCH_INTERVAL_MS / 1000}s): ${text}` });
    }
    setWatching(true);
    void runCommand(text, { silent: true, snapshot: true });
  }

  function submitCommand() {
    setWatching(false);
    void runCommand(cmd).then(() => setCmd(''));
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <PageSection title="Devbox — Claude Code in a microVM">
      {/* ── Boxes bar ── */}
      <style>{`
        @keyframes devbox-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        @keyframes devbox-spin { to { transform: rotate(360deg); } }
      `}</style>
      {/* Plain div, not <Card> — the Card component's own padding/layout rules
          fought the toolbar classes here and made spacing unpredictable. */}
      <div className="mb-4 rounded-lg border border-border bg-surface px-4 py-3">
        <div className="flex items-center justify-between gap-4 min-w-0">
        <div className="flex items-center gap-3 flex-wrap min-w-0 flex-1">
          <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">RUNTIME</span>
          {status ? (
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold ${status.deployed ? 'bg-success-bg text-success' : 'bg-danger-bg text-danger'}`}>
              <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full ${status.deployed ? 'bg-success' : 'bg-danger'}`} />
              {status.deployed ? `${status.runtimeName} · deployed` : 'not deployed'}
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1.5 text-[11px] ${statusError ? 'text-danger font-semibold' : 'text-text-tertiary'}`}>
              {!statusError && (
                <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-text-tertiary" style={{ animation: 'devbox-pulse 1.2s ease-in-out infinite' }} />
              )}
              {statusError
                ? (/403|Forbidden/i.test(statusError)
                    ? 'access denied — devbox requires the HR Admin role (masquerade menu, top right)'
                    : `status failed: ${statusError}`)
                : 'checking runtime…'}
            </span>
          )}
          <span aria-hidden="true" className="w-px h-4 bg-border mx-1" />
          <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">BOXES</span>
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            {boxes.map((box) => {
              const st = box.status ?? 'idle';
              return (
              <span
                key={box.id}
                onClick={() => selectBox(box.id)}
                title={`${STATUS_LABEL[st]}${box.currentTask ? ` — ${box.currentTask}` : ''} · session …${box.sessionId.slice(-12)}`}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold cursor-pointer border transition-colors ${activeBox?.id === box.id ? 'bg-primary text-white border-primary shadow-sm' : 'bg-surface text-text-secondary border-border hover:border-primary/50'}`}
              >
                <span
                  aria-hidden="true"
                  className={`w-1.5 h-1.5 rounded-full ${activeBox?.id === box.id && st !== 'running' && st !== 'waiting' && st !== 'error' ? 'bg-white' : STATUS_DOT[st]}`}
                  style={st === 'running' ? { animation: 'devbox-pulse 1s ease-in-out infinite' } : undefined}
                />
                {box.label}
                <span
                  onClick={(e) => { e.stopPropagation(); forgetBox(box.id); }}
                  title="Forget this box (workspace persists server-side until idle expiry)"
                  className="opacity-60 hover:opacity-100"
                >
                  ×
                </span>
              </span>
              );
            })}
            <button
              onClick={() => void provisionBox().catch(() => { /* toast already shown */ })}
              disabled={provisioning}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border border-dashed border-border bg-transparent text-text-secondary cursor-pointer hover:border-primary hover:text-primary transition-colors disabled:opacity-60 disabled:cursor-wait"
            >
              {provisioning && (
                <span aria-hidden="true" className="inline-block w-3 h-3 rounded-full border-[1.5px] border-primary border-t-transparent" style={{ animation: 'devbox-spin 0.8s linear infinite' }} />
              )}
              {provisioning ? 'provisioning…' : '+ new'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span
            className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-full border border-border text-[10px] text-text-tertiary cursor-help select-none shrink-0 hover:text-text-secondary hover:border-text-tertiary transition-colors"
            title={'Each box is its own runtime session — its own microVM + persistent /mnt/workspace.\nSurvives stop/resume · wiped on devbox image redeploys and after 14 idle days · 1 GB cap.'}
          >
            i
          </span>
          <span className="text-[10px] text-text-tertiary whitespace-nowrap hidden lg:inline select-none">⌘I quick-switch</span>
          <button
            onClick={() => void stopSession()}
            disabled={!activeBox}
            className="px-3 py-1.5 text-xs font-semibold rounded-md border border-border bg-surface text-text-secondary cursor-pointer whitespace-nowrap hover:text-danger hover:border-danger/50 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            Stop session
          </button>
        </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)] gap-5 items-start">
        {/* ── Left: task runner + execution timeline ── */}
        <div className="flex flex-col gap-3 min-w-0">
          {/* Composer: textarea + toolbar in one frame, like a chat input. */}
          <Card className="!p-0 overflow-hidden">
            <div className="px-3.5 pt-3 pb-1 flex items-center gap-2">
              <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">TASK</span>
              {activeBox && <span className={`text-[10px] text-text-tertiary ${mono}`}>→ {activeBox.label}</span>}
            </div>
            <textarea
              className="w-full min-h-[84px] text-[13px] leading-relaxed bg-transparent text-text-primary border-none px-3.5 py-2 resize-y outline-none box-border"
              placeholder="What should Claude Code do in the workspace? e.g. 'Scaffold a FastAPI service with tests and commit it.'"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void runTask(); }}
            />
            <div className="px-3.5 py-2.5 border-t border-border flex items-center gap-3 bg-surface-hover/40">
              <label className="flex items-center gap-1.5 text-[11px] text-text-tertiary cursor-pointer select-none">
                <input type="checkbox" checked={resume} onChange={(e) => setResume(e.target.checked)} />
                resume conversation
              </label>
              <div className="flex-1" />
              <span className="text-[10px] text-text-tertiary select-none hidden sm:inline">⌘⏎ to run</span>
              <button
                onClick={() => void runTask()}
                disabled={taskRunning || !prompt.trim()}
                className={`inline-flex items-center gap-2 px-[18px] py-1.5 border-none rounded-md font-semibold text-[13px] whitespace-nowrap transition-colors ${taskRunning || !prompt.trim() ? 'bg-surface-hover text-text-secondary cursor-not-allowed' : 'bg-primary text-white cursor-pointer hover:opacity-90'}`}
              >
                {taskRunning && (
                  <span aria-hidden="true" className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/70 border-t-transparent" style={{ animation: 'devbox-spin 0.8s linear infinite' }} />
                )}
                {taskRunning ? 'Running…' : '▶ Run task'}
              </button>
            </div>
          </Card>

          <Card className="!p-0 overflow-hidden">
            <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
              <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">EXECUTION TIMELINE</span>
              {activeBox && <span className={`text-[10px] text-text-tertiary ${mono}`}>{activeBox.label}</span>}
              {(taskRunning || activeBox?.status === 'running') && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-primary ml-auto">
                  <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-primary" style={{ animation: 'devbox-pulse 1s ease-in-out infinite' }} />
                  {taskRunning ? 'live' : 'tailing remote run (read-only)'}
                </span>
              )}
              {activeBox?.status === 'waiting' && !taskRunning && (
                <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-warning ml-auto">
                  <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-warning" />
                  waiting for your feedback — reply via a new task with resume on
                </span>
              )}
            </div>
            <div ref={timelineRef} className="overflow-y-auto overflow-x-hidden max-h-[560px] px-3.5 py-2">
              {timeline.length === 0 ? (
                <div className="py-10 text-center select-none">
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="w-8 h-8 mx-auto mb-2.5 text-text-tertiary" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2" />
                    <path d="m7 9 3 3-3 3" />
                    <path d="M13 15h4" />
                  </svg>
                  <div className="text-[13px] font-semibold text-text-secondary">No executions yet</div>
                  <div className="text-[12px] text-text-tertiary mt-1">
                    Describe a task above and hit <b>▶ Run task</b> — every tool call Claude Code makes streams here live.
                  </div>
                </div>
              ) : timeline.map((item) => {
                if (item.kind === 'meta') return (
                  <div key={item.id} className={`py-1 text-[11px] text-text-tertiary ${mono}`}>── {item.text}</div>
                );
                if (item.kind === 'text') return (
                  <div key={item.id} className="py-1.5 text-[13px] text-text-primary [&_pre]:overflow-x-auto [&_pre]:text-[12px] [&_code]:text-[12px] [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13.5px]">
                    <Markdown>{item.text}</Markdown>
                  </div>
                );
                if (item.kind === 'tool') return (
                  <div key={item.id} className="my-1.5 border border-border rounded-md overflow-hidden">
                    <div className="flex items-center gap-2 px-3 py-1.5 bg-surface-hover min-w-0">
                      <span className={`text-[12px] font-bold ${item.isError ? 'text-danger' : 'text-primary'}`}>{toolIcon(item.name)}</span>
                      <span className="text-[11px] font-semibold text-text-secondary">{item.name}</span>
                      <span className={`flex-1 min-w-0 text-[12px] text-text-primary overflow-hidden text-ellipsis whitespace-nowrap ${mono}`} title={item.summary}>{item.summary}</span>
                    </div>
                    {item.detail && (
                      <div className="px-3 py-1 text-[11px] text-text-tertiary border-t border-border">{item.detail}</div>
                    )}
                    {item.output !== undefined && (
                      <pre className={`m-0 px-3 py-2 text-[11.5px] leading-snug border-t border-border overflow-x-auto max-h-48 overflow-y-auto whitespace-pre-wrap ${mono} ${item.isError ? 'text-danger' : 'text-text-secondary'}`}>
                        {item.output || '(no output)'}
                      </pre>
                    )}
                  </div>
                );
                if (item.kind === 'result') return (
                  <div key={item.id} className="my-2 px-3 py-2 rounded-md bg-success-bg text-[12px] text-success">
                    {item.subtype} · {item.turns} turns · {(item.durationMs / 1000).toFixed(0)}s · ${item.costUsd.toFixed(4)}
                  </div>
                );
                if (item.kind === 'end') return (
                  <div key={item.id} className={`py-1 text-[11px] ${mono} ${item.exitCode === 0 ? 'text-text-tertiary' : 'text-danger'}`}>
                    ── exit {String(item.exitCode)}{item.timedOut ? ' (timed out)' : ''}
                    {item.stderr && item.exitCode !== 0 ? ` · ${item.stderr.slice(0, 300)}` : ''}
                  </div>
                );
                return (
                  <div key={item.id} className="my-2 px-3 py-2 rounded-md bg-danger-bg text-[12px] text-danger">{item.text}</div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* ── Right: command console — a real terminal frame ── */}
        <Card className="!p-0 overflow-hidden min-w-0">
          <div className="px-3.5 py-2.5 flex items-center gap-2 bg-[#161b22] border-b border-[#30363d]">
            <span aria-hidden="true" className="flex items-center gap-1.5 mr-1">
              <span className="w-2.5 h-2.5 rounded-full bg-[#ff5f57]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#febc2e]" />
              <span className="w-2.5 h-2.5 rounded-full bg-[#28c840]" />
            </span>
            <span className={`text-[11px] font-semibold text-[#e6edf3] select-none ${mono}`}>
              {activeBox ? `${activeBox.label} — /mnt/workspace` : 'console'}
            </span>
            <div className="flex-1" />
            <span className="text-[9.5px] text-[#8b949e] select-none hidden sm:inline" title="Deterministic shell — allowlisted read-only commands, no LLM">
              read-only · allowlisted
            </span>
            <button
              onClick={toggleWatch}
              title={cmd.trim()
                ? `Re-run "${cmd.trim()}" every ${WATCH_INTERVAL_MS / 1000}s — tail a workspace another actor is mutating`
                : `Re-run a command every ${WATCH_INTERVAL_MS / 1000}s (defaults to ls -la) — tail a workspace another actor is mutating`}
              className={`px-2 py-0.5 rounded-md text-[10px] font-semibold border cursor-pointer ${watching ? 'bg-primary text-white border-primary' : 'bg-transparent text-[#8b949e] border-[#30363d] hover:text-[#e6edf3]'}`}
            >
              {watching ? '◉ watching' : '◎ watch'}
            </button>
          </div>
          <div className="bg-[#0d1117]">
            <div ref={consoleRef} className={`h-[400px] overflow-y-auto px-3.5 py-2.5 text-[12px] leading-relaxed ${mono}`}>
              {consoleLines.length === 0 ? (
                <div className="text-[#8b949e]">
                  Run read-only commands inside the microVM workspace.
                  <div className="mt-1 text-[11px]">Try <span className="text-[#7ee787]">git log --oneline</span> or <span className="text-[#7ee787]">ls -la</span> — or click a command below.</div>
                </div>
              ) : consoleLines.map((line) => (
                <div key={line.id} className="whitespace-pre-wrap break-words">
                  {line.kind === 'cmd' && <span className="text-[#7ee787]">$ {line.text}</span>}
                  {line.kind === 'stdout' && <span className="text-[#e6edf3]">{line.text}</span>}
                  {line.kind === 'stderr' && <span className="text-[#ffa657]">{line.text}</span>}
                  {line.kind === 'exit' && <span className="text-[#8b949e]">[{line.text}]</span>}
                  {line.kind === 'err' && <span className="text-[#f85149]">✗ {line.text}</span>}
                </div>
              ))}
              {(cmdRunning || watching) && <div className="text-[#8b949e]">{watching ? `◉ watching every ${WATCH_INTERVAL_MS / 1000}s…` : '…'}</div>}
            </div>
            <div className="border-t border-[#30363d] px-3.5 py-2.5 flex items-center gap-2">
              <span className={`text-[12.5px] text-[#7ee787] ${mono}`}>$</span>
              <input
                className={`flex-1 min-w-0 text-[12.5px] bg-transparent text-[#e6edf3] placeholder-[#8b949e]/60 border-none outline-none ${mono}`}
                placeholder="git log --oneline"
                value={cmd}
                disabled={cmdRunning && !watching}
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitCommand(); }}
              />
              {cmdRunning && (
                <span aria-hidden="true" className="inline-block w-3 h-3 rounded-full border-[1.5px] border-[#8b949e] border-t-transparent shrink-0" style={{ animation: 'devbox-spin 0.8s linear infinite' }} />
              )}
            </div>
          </div>
          {status && status.commandAllowlist.length > 0 && (
            <div className="px-3 py-2 border-t border-border flex flex-wrap gap-1.5">
              {status.commandAllowlist.slice(0, 12).map((prefix) => (
                <span key={prefix} onClick={() => setCmd(prefix.trim() + ' ')} className="cursor-pointer">
                  <Chip mono>{prefix.trim()}</Chip>
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>
    </PageSection>
  );
}
