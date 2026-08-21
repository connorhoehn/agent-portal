import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { PageSection, Card, Chip } from '@connorhoehnslalom/ui-components/shared';
import { openShell } from '../../lib/terminalDock';
import { DEVBOX_MODELS } from '../../lib/devboxModels';
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
  fullExecEnabled?: boolean;
  /** True only when the DEPLOYED image understands a per-task model. */
  perTaskModel?: boolean;
  defaultModel?: string | null;
  allowedModels?: string[];
}

/** What the rest of the SDLC loop knows about a box (see BoxContext card). */
interface WorkJobRef {
  id: string; title: string; status: string; boxId: string | null; finishedAt: string | null;
}
interface AgentProjectRef {
  id: string; repoFullName: string; sessionId: string | null;
  orgProjectId: string | null; orgProjectName: string | null;
}

/** One entry in the task execution timeline. */
type TimelineItem =
  | { id: string; kind: 'meta'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'tool'; name: string; summary: string; detail?: string; output?: string; isError?: boolean }
  | { id: string; kind: 'result'; subtype: string; turns: number; durationMs: number; costUsd: number; text?: string }
  | { id: string; kind: 'end'; exitCode: number | null; timedOut: boolean; stderr?: string }
  | { id: string; kind: 'error'; text: string };


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


// ─── Page ─────────────────────────────────────────────────────────────────────

/** Models the container will accept — the shared list, mirroring DEVBOX_ALLOWED_MODELS. */
const TASK_MODELS = DEVBOX_MODELS;

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

  // What this machine is doing and for whom — the reverse links of the SDLC
  // loop. Jobs record the box that ran them; codebases record the workspace
  // session they were cloned into. A machine page that can't say either is a
  // dead end.
  const { data: jobsData } = useFetch<{ jobs: WorkJobRef[] }>('/api/work/jobs?limit=50', 15_000);
  const { data: projectsData } = useFetch<{ projects: AgentProjectRef[] }>('/api/agent-projects', 30_000);
  const boxJobs = (jobsData?.jobs ?? []).filter((j) => j.boxId === activeBox?.id);
  const liveJob = boxJobs.find((j) => j.status === 'running' || j.status === 'claimed') ?? null;
  const recentJobs = boxJobs.filter((j) => j !== liveJob).slice(0, 3);
  const boxProjects = (projectsData?.projects ?? []).filter(
    (p) => p.sessionId && p.sessionId === activeBox?.sessionId,
  );

  const selectBox = useCallback((id: string) => {
    setSearchParams((prev) => { prev.set('box', id); return prev; }, { replace: true });
  }, [setSearchParams]);

  // ── Per-box streams (in-memory; switching boxes preserves each stream) ─────
  const [timelines, setTimelines] = useState<Record<string, TimelineItem[]>>({});
  const [taskModel, setTaskModel] = useState<string>(TASK_MODELS[0]!.id);
  const timeline = activeBox ? (timelines[activeBox.id] ?? []) : [];

  const pushTimeline = useCallback((boxId: string, updater: (prev: TimelineItem[]) => TimelineItem[]) => {
    setTimelines((all) => ({ ...all, [boxId]: updater(all[boxId] ?? []) }));
  }, []);

  const [prompt, setPrompt] = useState('');
  const [resume, setResume] = useState(true);
  const [taskRunning, setTaskRunning] = useState(false);

  const idRef = useRef(0);
  const nextId = () => String(++idRef.current);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Auto-scroll the timeline as events land.
  useEffect(() => { timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight }); }, [timeline]);

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

  // Workspace snapshot. Uses the same read-only command API the job dispatcher
  // runs on, but renders the result as data — a file list and a git summary —
  // rather than as terminal output. The distinction matters: this pane is for
  // glancing, and anything you would want to type into belongs in a real PTY.
  const [wsFiles, setWsFiles] = useState<string[]>([]);
  const [wsGit, setWsGit] = useState<string[]>([]);
  const [wsLoading, setWsLoading] = useState(false);
  const [wsError, setWsError] = useState<string | null>(null);

  const refreshWorkspace = useCallback(async () => {
    const box = activeBox;
    if (!box || wsLoading) return;
    setWsLoading(true);
    setWsError(null);
    const collect = async (command: string): Promise<string[]> => {
      const lines: string[] = [];
      await readSse(`/api/devbox/${box.sessionId}/command`,
        { command, mode: 'full', cwd: '/mnt/workspace' },
        (ev) => {
          if (ev['type'] === 'stdout' || ev['type'] === 'stderr') {
            lines.push(...String(ev['text']).split('\n'));
          }
        });
      return lines.map((l) => l.trim()).filter(Boolean);
    };
    try {
      // -F marks directories with a trailing slash, which is what the list
      // colours on; -A skips . and .. without hiding dotfiles.
      const [files, git] = await Promise.all([
        collect('ls -AF'),
        collect('git log --oneline -3 2>/dev/null; git status --short 2>/dev/null | head -5'),
      ]);
      setWsFiles(files);
      setWsGit(git);
    } catch (err) {
      setWsError((err as Error).message);
    } finally {
      setWsLoading(false);
    }
  }, [activeBox, wsLoading]);

  // Read once per box rather than polling: a workspace changes when something
  // acts on it, and the dock is where you watch that happen live.
  useEffect(() => {
    setWsFiles([]); setWsGit([]); setWsError(null);
    if (activeBox) void refreshWorkspace();
    // refreshWorkspace is deliberately omitted — including it would re-read on
    // every keystroke that changes unrelated state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeBox?.id]);

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
      await readSse(`/api/devbox/${box.sessionId}/task`, { prompt: text, resume, model: taskModel }, (ev) => {
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


  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <PageSection title="Computers — Claude Code in a microVM">
      {/* ── Boxes bar ── */}
      <style>{`
        @keyframes devbox-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
        @keyframes devbox-spin { to { transform: rotate(360deg); } }
      `}</style>
      {/* Card defaults to padding="none" — pass an explicit size or it renders
          edge-to-edge (that was the cause of the cramped toolbar, not a
          conflict with the component's own styles). */}
      <Card padding="sm" className="mb-4">
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
          {activeBox?.stopsInMs != null && (
            <span
              className={`text-[10px] whitespace-nowrap select-none ${
                activeBox.stopsInMs < 5 * 60_000 ? 'text-warning' : 'text-text-tertiary'}`}
              title={'Boxes stop on their own: after a stretch with nothing happening, and at a hard ceiling regardless of activity.\nThe workspace is a cache — the repository and its run history survive.'}
            >
              stops in {Math.max(0, Math.round(activeBox.stopsInMs / 60_000))}m
            </span>
          )}
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
      </Card>

      {/* The terminal gets the wider column. Running a command is the cheap,
          deterministic, most-used thing you do with a box; delegating to Claude
          Code is the occasional expensive one. The old split had it backwards,
          and 420px is not enough width for `ls -la` to avoid wrapping. */}
      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,440px)_minmax(0,1fr)] gap-5 items-start">
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
              {/* Offered only when the deployed runtime can honour it. A
                  picker that silently does nothing because the image predates
                  the feature is worse than no picker. */}
              {status?.perTaskModel ? (
                <select
                  value={taskModel}
                  onChange={(e) => setTaskModel(e.target.value)}
                  title={TASK_MODELS.find((m) => m.id === taskModel)?.hint}
                  className="text-[11px] bg-surface text-text-secondary border border-border rounded px-1.5 py-0.5 cursor-pointer outline-none"
                >
                  {TASK_MODELS
                    .filter((m) => (status.allowedModels ?? []).includes(m.id))
                    .map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              ) : status?.defaultModel ? (
                <span
                  className={`text-[10px] text-text-tertiary ${mono}`}
                  title="This runtime was deployed before per-task model selection. Redeploy the devbox image to choose a model per task."
                >
                  {status.defaultModel.replace(/^us\.anthropic\.claude-/, '').replace(/-\d{8}-v1:0$/, '')}
                </span>
              ) : null}
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

        {/* ── Workspace ──────────────────────────────────────────────────
             This used to be a black pane styled like a terminal — traffic
             lights, a prompt, monospace output — that was not a terminal: no
             stdin, no colour, no interactivity. Now that a real PTY exists in
             the dock, a look-alike is worse than nothing, because it invites
             you to type into something that cannot answer the way it looks
             like it will.

             What is left is what the PTY does not give you at a glance: the
             box's identity and the state of its workspace, as data. Anything
             interactive is one click away in a terminal that really is one. */}
        <div className="flex flex-col gap-3 min-w-0">
          {/* ── This box in the loop: the job it's running, the jobs it ran,
               and the codebases checked out here — each one a link back into
               the surface that owns it. ── */}
          {activeBox && (liveJob || recentJobs.length > 0 || boxProjects.length > 0) && (
            <Card className="!p-0 overflow-hidden">
              <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
                <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">THIS BOX</span>
                <span className={`text-[10px] text-text-tertiary ${mono}`}>{activeBox.label}</span>
              </div>
              <div className="divide-y divide-border">
                {liveJob && (
                  <div className="px-3.5 py-2 flex items-center gap-2 min-w-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" style={{ animation: 'devbox-pulse 1s ease-in-out infinite' }} />
                    <span className="text-[11px] text-text-tertiary shrink-0">running job</span>
                    <Link to={`/iq/work/${liveJob.id}`} className="text-[12px] text-primary no-underline hover:underline truncate">
                      {liveJob.title}
                    </Link>
                  </div>
                )}
                {recentJobs.map((j) => (
                  <div key={j.id} className="px-3.5 py-2 flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-text-tertiary shrink-0">{j.status.replace('_', ' ')}</span>
                    <Link to={`/iq/work/${j.id}`} className="text-[12px] text-text-secondary no-underline hover:text-primary hover:underline truncate">
                      {j.title}
                    </Link>
                  </div>
                ))}
                {boxProjects.map((p) => (
                  <div key={p.id} className="px-3.5 py-2 flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-text-tertiary shrink-0">checked out</span>
                    <Link
                      to={`/admin/projects?project=${p.id}`}
                      className={`text-[12px] text-text-secondary no-underline hover:text-primary hover:underline truncate ${mono}`}
                    >
                      {p.repoFullName}
                    </Link>
                    {p.orgProjectId && p.orgProjectName && (
                      <Link
                        to={`/iq/projects/${p.orgProjectId}`}
                        title={`Delivers: ${p.orgProjectName}`}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary no-underline hover:underline truncate shrink-0 max-w-[40%]"
                      >
                        {p.orgProjectName}
                      </Link>
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}

          <Card className="!p-0 overflow-hidden">
            <div className="px-3.5 py-2.5 border-b border-border flex items-center gap-2">
              <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">WORKSPACE</span>
              {activeBox && <span className={`text-[10px] text-text-tertiary ${mono}`}>/mnt/workspace</span>}
              <div className="flex-1" />
              <button
                onClick={() => void refreshWorkspace()}
                disabled={!activeBox || wsLoading}
                className="text-[11px] px-2 py-0.5 rounded border border-border bg-surface text-text-secondary cursor-pointer hover:text-primary disabled:opacity-40"
              >
                {wsLoading ? 'reading…' : 'refresh'}
              </button>
              {activeBox && (
                <button
                  onClick={() => openShell({ id: activeBox.id, label: activeBox.label, sessionId: activeBox.sessionId })}
                  title="Open a real PTY — ⌘' toggles the dock"
                  className="text-[11px] px-2 py-0.5 rounded border border-primary/50 bg-surface font-semibold text-primary cursor-pointer hover:bg-primary hover:text-white transition-colors"
                >
                  Open terminal ⌘&apos;
                </button>
              )}
            </div>

            {!activeBox ? (
              <div className="px-3.5 py-6 text-[12.5px] text-text-tertiary text-center">
                No box selected. Create one above to get a workspace.
              </div>
            ) : wsError ? (
              <div className="px-3.5 py-4 text-[12px] text-danger">{wsError}</div>
            ) : (
              <div className="divide-y divide-border">
                <div className="px-3.5 py-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1.5">Files</div>
                  {wsFiles.length === 0 ? (
                    <div className="text-[12px] text-text-tertiary">
                      {wsLoading ? 'reading…' : 'Empty — nothing has been written here yet.'}
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-0.5">
                      {wsFiles.slice(0, 24).map((f) => (
                        <span key={f} className={`text-[12px] truncate ${mono} ${f.endsWith('/') ? 'text-primary' : 'text-text-secondary'}`} title={f}>
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                  {wsFiles.length > 24 && (
                    <div className="text-[11px] text-text-tertiary mt-1">+{wsFiles.length - 24} more</div>
                  )}
                </div>

                <div className="px-3.5 py-2.5">
                  <div className="text-[10px] uppercase tracking-wide text-text-tertiary mb-1.5">Git</div>
                  {wsGit.length === 0 ? (
                    <div className="text-[12px] text-text-tertiary">
                      {wsLoading ? 'reading…' : 'Not a git repository.'}
                    </div>
                  ) : (
                    <div className="flex flex-col gap-0.5">
                      {wsGit.map((l, i) => (
                        <span key={i} className={`text-[12px] text-text-secondary truncate ${mono}`} title={l}>{l}</span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </PageSection>
  );
}
