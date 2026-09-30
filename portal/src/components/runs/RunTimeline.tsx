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
import {
  Card, Chip, CodeBlock, EmptyState, Inline, InlineAlert, MetaLine, SectionLabel, Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { Markdown } from '../Markdown';
import { toolSummary as summarizeTool } from './toolSummary';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One entry in the task execution timeline. */
export type TimelineItem =
  | { id: string; kind: 'meta'; text: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'tool'; name: string; summary: string; detail?: string; output?: string; isError?: boolean }
  | { id: string; kind: 'result'; subtype: string; turns: number; durationMs: number; costUsd: number; text?: string }
  | { id: string; kind: 'end'; exitCode: number | null; timedOut: boolean; stderr?: string }
  | { id: string; kind: 'error'; text: string };

/** Liveness of the box's event tail — see the watchdog in the tail effect. */
type TailState = 'idle' | 'connecting' | 'live' | 'retrying' | 'unavailable';

/** No heartbeat for this long means the stream is dead, whatever the socket says. */
const STALL_AFTER_MS = 60_000;
const WATCHDOG_EVERY_MS = 10_000;

// ─── Rendering helpers ───────────────────────────────────────────────────────

const mono = 'font-["Fira_Code","Cascadia_Code","JetBrains_Mono",monospace]';

// `toolSummary` now lives in ./toolSummary so the local-compute console can
// share the vocabulary without importing this component. Re-exported here
// because call sites already import it from this module.
export { toolSummary } from './toolSummary';

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

/**
 * The empty-state glyph — a terminal with a prompt caret.
 *
 * An `<svg>` rather than a library component on purpose: the icon set has no
 * "terminal" mark, and inline SVG is not what the component-discipline rule is
 * about. It counts styled text and layout elements, which is where hand-rolled
 * UI actually diverges from the design system; an icon path does not.
 */
function TimelineGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m7 9 3 3-3 3" />
      <path d="M13 15h4" />
    </svg>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface RunTimelineHandle {
  /** Append a local meta/error row (e.g. "session stopped") to the current
      box's stream. Local-only — the server tail is unaffected. */
  push: (item: { kind: 'meta' | 'error'; text: string }) => void;
}

export interface RunTimelineProps {
  boxId: string | null;
  /** Tail this SSE URL instead of the box's own (`/api/devbox/boxes/:id/tail`).
      Used for a pipeline run's event stream (`/api/runs/:id/events`), whose
      event-catalog frames (`pipeline:run:*`, `pipeline:step:*`,
      `pipeline.approval.*`) render as timeline meta rows. */
  src?: string | null;
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
    boxId: boxIdProp,
    src = null,
    title = 'EXECUTION TIMELINE',
    maxHeightClass = 'max-h-[calc(100vh-260px)]',
    headerExtra,
    emptyHint,
    onEvent,
  },
  ref,
) {
  // The stream key: a box id, or the explicit stream URL when one is given.
  const boxId = src ?? boxIdProp;
  // ── Per-box streams (in-memory; switching boxes preserves each stream) ─────
  const [timelines, setTimelines] = useState<Record<string, TimelineItem[]>>({});
  const timeline = boxId ? (timelines[boxId] ?? []) : [];

  // Whether the live tail is actually live. A frozen timeline and a quiet one
  // look identical, so this is the only thing that tells them apart.
  const [tailState, setTailState] = useState<TailState>('idle');

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
    if (typeof type === 'string' && /^pipeline[:.]/.test(type)) {
      // An event-catalog frame from a pipeline run stream — one meta row each.
      const text = [type, ev['stepId'], ev['detail'] ?? ev['status']]
        .filter((part) => typeof part === 'string' && part).join(' · ');
      pushTimeline(box, (prev) => [...prev, { id: nextId(), kind: type.endsWith('failed') ? 'error' : 'meta', text }]);
    } else if (type === 'task_started') {
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
          const { summary, detail } = summarizeTool(name, (block['input'] ?? {}) as Record<string, unknown>);
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
    let es: EventSource | null = null;
    let lastSeen = Date.now();
    let disposed = false;

    const open = () => {
      es?.close();
      if (disposed) return;
      es = new EventSource(src ?? `/api/devbox/boxes/${encodeURIComponent(boxId)}/tail`);
      lastSeen = Date.now();
      setTailState('connecting');

      es.onopen = () => {
        lastSeen = Date.now();
        setTailState('live');
        // Replay rebuilds the full history — clear so reconnects don't duplicate.
        setTimelines((all) => ({ ...all, [boxId]: [] }));
      };
      // The server sends a NAMED heartbeat every 25s precisely so a quiet
      // stream is distinguishable from a dead one (see middleware lib/sse.ts).
      // Listening for it is the whole reason the watchdog below can be honest.
      es.addEventListener('heartbeat', () => {
        lastSeen = Date.now();
        setTailState('live');
      });
      es.onmessage = (evt: MessageEvent) => {
        lastSeen = Date.now();
        setTailState('live');
        try {
          const ev = JSON.parse(evt.data) as Record<string, unknown>;
          // The server sends this once, as the last frame, when the computer is
          // removed. Take it at its word and stop: the stream is not coming
          // back, so reconnecting would only spend a round-trip to be told 404,
          // and the watchdog must not treat the silence that follows as a stall
          // worth healing.
          if (ev['type'] === 'box_removed') {
            disposed = true;
            setTailState('unavailable');
            es?.close();
            return;
          }
          onEventRef.current?.(ev);
          handleTaskEvent(boxId, ev);
        } catch { /* non-JSON frame — skip */ }
      };
      // EventSource hides the HTTP status but not the outcome: the browser
      // gives up and closes on a 404 — the box is gone, which after a
      // middleware restart is every box, since the fleet registry is in
      // memory — whereas a transient blip returns to CONNECTING and retries
      // itself. Saying "reconnecting" about a log that is never coming back
      // is exactly the lie this is here to avoid.
      es.onerror = () => {
        setTailState(es?.readyState === EventSource.CLOSED ? 'unavailable' : 'retrying');
      };
    };

    // Watchdog. EventSource reconnects itself when the socket breaks, but a
    // stream can die without the socket breaking: Vite's dev proxy holds the
    // browser side open after the upstream middleware goes away, so `onerror`
    // never fires and the timeline simply stops updating while still looking
    // healthy. Missing heartbeats is the only evidence of that, so treat a
    // heartbeat drought as a dead stream and rebuild it.
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastSeen > STALL_AFTER_MS) open();
    }, WATCHDOG_EVERY_MS);

    open();
    return () => {
      disposed = true;
      window.clearInterval(watchdog);
      es?.close();
      setTailState('idle');
    };
  }, [boxId, src, handleTaskEvent]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Card className="!p-0 overflow-hidden">
      <Inline gap="sm" align="center" className="px-3.5 py-3 border-b border-border">
        <SectionLabel>{title}</SectionLabel>
        {headerExtra}
        {/* Only shown when the tail is NOT healthy. A working stream needs no
            chrome; a dead one must not be able to pass for a quiet one. */}
        {(tailState === 'retrying' || tailState === 'unavailable') && (
          <Chip
            size="xs"
            tone={tailState === 'unavailable' ? 'danger' : 'neutral'}
            className="ml-auto"
            title={tailState === 'unavailable'
              ? 'The server is no longer streaming this computer\'s log — it was removed, or the middleware restarted (the event buffer lives in its memory).'
              : 'Lost the log stream — retrying.'}
          >
            {tailState === 'unavailable' ? 'LOG UNAVAILABLE' : 'RECONNECTING…'}
          </Chip>
        )}
      </Inline>
      <Stack gap="none" className={`overflow-y-auto overflow-x-hidden min-h-[280px] ${maxHeightClass} px-3.5 py-2`} ref={scrollRef}>
        {timeline.length === 0 ? (
          <EmptyState
            icon={<TimelineGlyph />}
            title="No executions yet"
            description={emptyHint ?? 'Every tool call Claude Code makes streams here live.'}
          />
        ) : timeline.map((item) => {
          if (item.kind === 'meta') return (
            <MetaLine key={item.id} size="xs" className={`py-1 ${mono}`} items={[`── ${item.text}`]} />
          );
          if (item.kind === 'text') return (
            <Stack key={item.id} gap="none" className="py-1.5 text-[13px] text-text-primary [&_pre]:overflow-x-auto [&_pre]:text-[12px] [&_code]:text-[12px] [&_h1]:text-[15px] [&_h2]:text-[14px] [&_h3]:text-[13.5px]">
              <Markdown>{item.text}</Markdown>
            </Stack>
          );
          if (item.kind === 'tool') return (
            <Stack key={item.id} gap="none" className="my-1.5 border border-border rounded-md overflow-hidden">
              <Inline gap="sm" align="center" className="px-3 py-1.5 bg-surface-hover min-w-0">
                <Chip size="xs" tone={item.isError ? 'danger' : 'accent'}>{toolIcon(item.name)}</Chip>
                <SectionLabel>{item.name}</SectionLabel>
                {/* The one-line argument summary. Truncation is the point — a
                    Read of a long path must not push the tool name off-screen —
                    so the full text lives in the title attribute. */}
                <MetaLine
                  size="sm"
                  className={`flex-1 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap ${mono}`}
                  items={[<span key="s" title={item.summary}>{item.summary}</span>]}
                />
              </Inline>
              {item.detail && (
                <MetaLine size="xs" className="px-3 py-1 border-t border-border" items={[item.detail]} />
              )}
              {item.output !== undefined && (
                <CodeBlock
                  language="text"
                  copyButton={false}
                  className={`border-t border-border max-h-48 overflow-auto ${item.isError ? 'text-danger' : ''}`}
                  code={item.output || '(no output)'}
                />
              )}
            </Stack>
          );
          if (item.kind === 'result') return (
            <InlineAlert key={item.id} tone="success" className="my-2">
              <MetaLine
                size="sm"
                items={[
                  item.subtype,
                  `${item.turns} turns`,
                  `${(item.durationMs / 1000).toFixed(0)}s`,
                  `$${item.costUsd.toFixed(4)}`,
                ]}
              />
            </InlineAlert>
          );
          if (item.kind === 'end') return (
            <MetaLine
              key={item.id}
              size="xs"
              tone="tertiary"
              // MetaLineTone is tertiary|secondary only — severity is not one of
              // its axes — so a non-zero exit takes its colour from a class.
              className={`py-1 ${mono} ${item.exitCode === 0 ? '' : 'text-danger'}`}
              items={[
                `── exit ${String(item.exitCode)}${item.timedOut ? ' (timed out)' : ''}`,
                item.stderr && item.exitCode !== 0 ? item.stderr.slice(0, 300) : null,
              ]}
            />
          );
          return (
            <InlineAlert key={item.id} tone="error" className="my-2">{item.text}</InlineAlert>
          );
        })}
      </Stack>
    </Card>
  );
});

export default RunTimeline;
