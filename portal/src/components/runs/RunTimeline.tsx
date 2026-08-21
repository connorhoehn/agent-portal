// RunTimeline — the execution timeline for a Claude Code run, extracted from
// the inline copy in pages/admin/DevboxPage.tsx so any page that can name a
// box can watch the run inside it (Computers, bot detail).
//
// It owns the whole live-tail lifecycle: an EventSource on the box's server
// tail, clear-on-open replay semantics (the server replays its buffer on
// connect, so each open must clear or a reconnect duplicates history), the
// stream-json → timeline transform, and the renderer. Per-box streams are kept
// in one keyed record so switching boxes preserves each stream, exactly as the
// Computers page always did.
//
// Deliberately NOT here: toast heartbeats and other task-runner concerns.
// Callers that want them subscribe via `onEvent`, which sees every raw frame
// before it is transformed.

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Card } from '@connorhoehnslalom/ui-components/shared';
import { Markdown } from '../Markdown';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One entry in the task execution timeline. */
export type TimelineItem =
  | { id: string; kind: 'meta'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'tool'; name: string; summary: string; detail?: string; output?: string; isError?: boolean }
  | { id: string; kind: 'result'; subtype: string; turns: number; durationMs: number; costUsd: number; text?: string }
  | { id: string; kind: 'end'; exitCode: number | null; timedOut: boolean; stderr?: string }
  | { id: string; kind: 'error'; text: string };

// ─── Rendering helpers ───────────────────────────────────────────────────────

const mono = 'font-["Fira_Code","Cascadia_Code","JetBrains_Mono",monospace]';

export function toolSummary(name: string, input: Record<string, unknown>): { summary: string; detail?: string } {
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

// ─── Component ───────────────────────────────────────────────────────────────

export interface RunTimelineHandle {
  /** Append a local meta/error row (e.g. "session stopped") to the current
      box's stream. Local-only — the server tail is unaffected. */
  push: (item: { kind: 'meta' | 'error'; text: string }) => void;
}

export interface RunTimelineProps {
  boxId: string | null;
  title?: string;
  /** Tailwind max-height class for the scroll body. */
  maxHeightClass?: string;
  /** Extra header content (status pulses, box label) rendered after the title. */
  headerExtra?: ReactNode;
  /** Empty-state hint line under "No executions yet". */
  emptyHint?: ReactNode;
  /** Sees every raw tail frame, before transformation — for page-specific
      concerns (toast heartbeats) that must stay out of the shared component. */
  onEvent?: (ev: Record<string, unknown>) => void;
}

export const RunTimeline = forwardRef<RunTimelineHandle, RunTimelineProps>(function RunTimeline(
  {
    boxId,
    title = 'EXECUTION TIMELINE',
    maxHeightClass = 'max-h-[calc(100vh-260px)]',
    headerExtra,
    emptyHint,
    onEvent,
  },
  ref,
) {
  // ── Per-box streams (in-memory; switching boxes preserves each stream) ─────
  const [timelines, setTimelines] = useState<Record<string, TimelineItem[]>>({});
  const timeline = boxId ? (timelines[boxId] ?? []) : [];

  const idRef = useRef(0);
  const nextId = useCallback(() => String(++idRef.current), []);
  const scrollRef = useRef<HTMLDivElement>(null);

  const pushTimeline = useCallback((box: string, updater: (prev: TimelineItem[]) => TimelineItem[]) => {
    setTimelines((all) => ({ ...all, [box]: updater(all[box] ?? []) }));
  }, []);

  useImperativeHandle(ref, () => ({
    push: (item) => {
      if (!boxId) return;
      pushTimeline(boxId, (prev) => [...prev, { id: nextId(), ...item }]);
    },
  }), [boxId, pushTimeline, nextId]);

  // Auto-scroll the timeline as events land.
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [timeline]);

  const handleTaskEvent = useCallback((box: string, ev: Record<string, unknown>) => {
    const type = ev['type'];
    if (type === 'task_started') {
      pushTimeline(box, (prev) => [...prev, { id: nextId(), kind: 'meta', text: `▶ task: ${String(ev['prompt'] ?? '')}` }]);
    } else if (type === 'devbox_start') {
      const persistent = ev['workspace_persistent'] ? 'persistent' : 'EPHEMERAL — no session storage mount!';
      pushTimeline(box, (prev) => [...prev, {
        id: nextId(), kind: 'meta',
        text: `workspace ${String(ev['workspace'])} [${persistent}] · ${String(ev['model'])}`,
      }]);
    } else if (type === 'assistant') {
      const content = ((ev['message'] as { content?: unknown[] })?.content ?? []) as Record<string, unknown>[];
      for (const block of content) {
        if (block['type'] === 'text' && String(block['text'] ?? '').trim()) {
          pushTimeline(box, (prev) => [...prev, { id: nextId(), kind: 'text', text: String(block['text']) }]);
        } else if (block['type'] === 'tool_use') {
          const name = String(block['name'] ?? 'tool');
          const { summary, detail } = toolSummary(name, (block['input'] ?? {}) as Record<string, unknown>);
          // Keyed by the tool_use id so the matching tool_result attaches below.
          pushTimeline(box, (prev) => [...prev, { id: String(block['id'] ?? nextId()), kind: 'tool', name, summary, detail }]);
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
        pushTimeline(box, (prev) => prev.map((item) =>
          item.kind === 'tool' && item.id === target ? { ...item, output, isError } : item,
        ));
      }
    } else if (type === 'result') {
      pushTimeline(box, (prev) => [...prev, {
        id: nextId(), kind: 'result',
        subtype: String(ev['subtype'] ?? ''),
        turns: Number(ev['num_turns'] ?? 0),
        durationMs: Number(ev['duration_ms'] ?? 0),
        costUsd: Number(ev['total_cost_usd'] ?? 0),
        text: typeof ev['result'] === 'string' ? (ev['result'] as string) : undefined,
      }]);
    } else if (type === 'devbox_end') {
      pushTimeline(box, (prev) => [...prev, {
        id: nextId(), kind: 'end',
        exitCode: (ev['exit_code'] ?? null) as number | null,
        timedOut: Boolean(ev['timed_out']),
        stderr: ev['stderr'] ? String(ev['stderr']) : undefined,
      }]);
    } else if (type === 'devbox_error') {
      pushTimeline(box, (prev) => [...prev, { id: nextId(), kind: 'error', text: String(ev['error'] ?? 'unknown error') }]);
    }
  }, [pushTimeline, nextId]);

  // ── Live tail — the timeline's single source of truth ──────────────────────
  // Every task event is teed server-side into the box's event log; this SSE
  // subscription replays the buffer then streams live. That means the timeline
  // survives reloads, and shows runs started by OTHER clients (curl, notebook,
  // a queue dispatcher) — read-only observation mode.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  useEffect(() => {
    if (!boxId) return;
    const es = new EventSource(`/api/devbox/boxes/${encodeURIComponent(boxId)}/tail`);
    es.onopen = () => {
      // Replay rebuilds the full history — clear so reconnects don't duplicate.
      setTimelines((all) => ({ ...all, [boxId]: [] }));
    };
    es.onmessage = (evt: MessageEvent) => {
      try {
        const ev = JSON.parse(evt.data) as Record<string, unknown>;
        onEventRef.current?.(ev);
        handleTaskEvent(boxId, ev);
      } catch { /* non-JSON frame — skip */ }
    };
    return () => es.close();
  }, [boxId, handleTaskEvent]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Card className="!p-0 overflow-hidden">
      <style>{`@keyframes runtl-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }`}</style>
      <div className="px-3.5 py-3 border-b border-border flex items-center gap-2">
        <span className="text-xs font-semibold text-text-secondary tracking-wide select-none">{title}</span>
        {headerExtra}
      </div>
      <div ref={scrollRef} className={`overflow-y-auto overflow-x-hidden min-h-[280px] ${maxHeightClass} px-3.5 py-2`}>
        {timeline.length === 0 ? (
          <div className="py-10 text-center select-none">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="w-8 h-8 mx-auto mb-2.5 text-text-tertiary" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <path d="m7 9 3 3-3 3" />
              <path d="M13 15h4" />
            </svg>
            <div className="text-[13px] font-semibold text-text-secondary">No executions yet</div>
            <div className="text-[12px] text-text-tertiary mt-1">
              {emptyHint ?? 'Every tool call Claude Code makes streams here live.'}
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
  );
});

export default RunTimeline;
