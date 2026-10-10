// The orgiq and pipelines activity/work graphs (docs/activity-graph-migration.md):
// realtime-modules' `useWorkGraph` (snapshot + stream handshake) into
// ui-components' `WorkGraph`, the way realtime-examples' ActiveWorkGraphPanel
// composes them. The BFF projects initiatives, work items, bot runs, bots and
// linked documents (GET /api/work-graph/...); live changes arrive on the
// gateway's work-graph stream as this viewer's own deltas (lib/workGraph.ts).
// Only when the stream is refused (or no gateway is connected) does the reader
// fall back to the content-free hint on `orgiq:workgraph`, answered with a
// fresh, re-authorized snapshot.

import { useCallback, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useActivity, useCursor, useGatewayOptional, useWorkGraph } from '@connorhoehnslalom/realtime-modules/client';
import {
  WorkGraph, type WorkActivityView, type WorkActivityWindow, type WorkGraphProps, type WorkGraphSelection, type WorkGraphViewport,
} from '@connorhoehnslalom/ui-components/graph';
import { WrappedCursorOverlay } from '@connorhoehnslalom/ui-components/integrations/realtime';
import { useSession } from '../../lib/auth';
import {
  calendarDay, createWorkGraphTransport, isWorkGraphHint, workGraphHintChannel, viewerTimezone, workGraphNodeHref,
  workGraphHeading, workGraphPresentation, workGraphQueryWindow, workGraphSubjectKey, workGraphViewState,
  type OrgiqWorkGraphTransport, type WorkGraphLiveMode, type WorkGraphSubject,
} from '../../lib/workGraph';

/** Fallback only: subscribes the activity feature to the hint channel and forwards matching rows. */
function LiveHints({ subject, transport }: { subject: WorkGraphSubject; transport: OrgiqWorkGraphTransport }) {
  const { events } = useActivity(workGraphHintChannel(subject));
  const seen = useRef(events.length);
  useEffect(() => {
    const fresh = events.slice(seen.current);
    seen.current = events.length;
    if (fresh.some(event => isWorkGraphHint(event, subject))) transport.hint();
  }, [events, subject, transport]);
  return null;
}

/** Peers' pointers over the canvas: `cursor:<channel>`, judged by the channel family's read authority. */
function CursorLayer({ channel, className, children }: { channel: string; className: string | undefined; children: ReactNode }) {
  const gateway = useGatewayOptional();
  // One socket object per gateway: `useCursor` resubscribes whenever its
  // `onMessage` changes, and an inline object made a new one every render —
  // each resubscribe's `subscribed` frame set state and rendered again
  // ("Maximum update depth exceeded" on every initiative Overview).
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;
  const socket = useMemo(() => ({
    send: (frame: Parameters<NonNullable<typeof gateway>['send']>[0]) => gatewayRef.current?.send(frame),
    onMessage: (handler: Parameters<NonNullable<typeof gateway>['onMessage']>[0]) => gatewayRef.current?.onMessage(handler) ?? (() => undefined),
  }), []);
  const cursor = useCursor(channel, { mode: 'canvas', socket });
  return <WrappedCursorOverlay cursor={cursor} {...(className ? { className } : {})}>{children}</WrappedCursorOverlay>;
}

export interface WorkGraphActivityProps {
  subject: WorkGraphSubject;
  /** YYYY-MM-DD in the viewer's zone; today when omitted. */
  day?: string;
  title?: string;
  /** Offers the pop-out control (the host owns the standalone route). */
  onPopOut?: () => void;
  mode?: 'split' | 'full';
  /** Tailwind sizing for the canvas; the graph needs a height. */
  className?: string;
  /** A gateway channel whose family admits `cursor`: peers' pointers show over the graph. */
  cursorChannel?: string;
  /** Opening a node: the host decides (the Communication plane opens detail in the right pane first).
   *  Given the node's page, when the id names one plainly. Absent: navigate to that page. */
  onOpenNode?: (node: { id: string; title: string; kind: string }, href: string | null) => void;
  /** The node's share/collaboration affordance (the library inspector's request), e.g. "Share to a conversation". */
  onRequestCollaboration?: WorkGraphProps['onRequestCollaboration'];
  /** Copy as a reference: the library inspector's "Reference". */
  onReference?: WorkGraphProps['onReference'];
  /** The graph's own empty copy is the library's; a host may name why it is empty instead. */
  emptyMessage?: string;
  /** The whole snapshot reply, for a subject that wraps it (`shared-work`'s `{ snapshot, sharing }`). */
  onEnvelope?: (body: unknown) => void;
  /** Reports the loaded nodes (a host lists them beside the canvas). */
  onNodes?: (nodes: readonly { id: string; title: string; kind: string; href: string | null }[]) => void;
}

export interface WorkGraphSourceOptions {
  subject: WorkGraphSubject;
  /** YYYY-MM-DD in the viewer's zone; today when omitted. */
  day?: string | undefined;
  /** The whole snapshot reply, for a subject that wraps it (`shared-work`'s `{ snapshot, sharing }`). */
  onEnvelope?: ((body: unknown) => void) | undefined;
}

/** The snapshot + stream handshake for one subject, shared by the canvas and by
 *  hosts that only list the recent events (the initiative Overview). Render
 *  `liveHints` beside the consumer: it is the stream-refused fallback. */
export function useWorkGraphSource({ subject, day: wantedDay, onEnvelope }: WorkGraphSourceOptions) {
  const envelopeRef = useRef(onEnvelope);
  envelopeRef.current = onEnvelope;
  const { session } = useSession();
  const gateway = useGatewayOptional();
  const connected = gateway?.connectionState === 'connected';
  // The transport reads the current connection through a ref, so a new context
  // value (every reconnect) does not restart the hook's handshake.
  const gatewayRef = useRef(gateway);
  gatewayRef.current = gateway;
  const timezone = useMemo(() => viewerTimezone(), []);
  const day = wantedDay ?? calendarDay(timezone);
  const subjectKey = workGraphSubjectKey(subject);
  const [liveMode, setLiveMode] = useState<WorkGraphLiveMode>('stream');
  // One transport per subject: changing it restarts the hook's handshake.
  const transport = useMemo(() => createWorkGraphTransport(subject, {
    gateway: gateway ? {
      send: frame => gatewayRef.current?.send(frame),
      onMessage: handler => gatewayRef.current?.onMessage(handler) ?? (() => undefined),
    } : null,
    isConnected: () => gatewayRef.current?.connectionState === 'connected',
    onModeChange: setLiveMode,
    onEnvelope: body => envelopeRef.current?.(body),
  }), [subjectKey, !!gateway]); // eslint-disable-line react-hooks/exhaustive-deps
  // A (re)connected gateway moves hint-path readers back onto the stream.
  useEffect(() => { if (connected) transport.resume(); }, [connected, transport]);
  const window = useMemo(() => workGraphQueryWindow(day, timezone), [day, timezone]);
  const scope = useMemo(() => ({ viewerId: session?.sub ?? 'anonymous', personId: subjectKey, day, timezone }), [session?.sub, subjectKey, day, timezone]);
  const result = useWorkGraph({ scope, transport, enabled: !!session, schemaVersion: 2, window });
  const liveHints = connected && liveMode === 'hints' ? <LiveHints key={subjectKey} subject={subject} transport={transport} /> : null;
  return { result, day, timezone, subjectKey, connected, liveMode, liveHints };
}

export function WorkGraphActivity({
  subject, day: wantedDay, title, onPopOut, mode = 'split', className, cursorChannel, onOpenNode, onRequestCollaboration, onReference, emptyMessage, onNodes, onEnvelope,
}: WorkGraphActivityProps) {
  const navigate = useNavigate();
  const { result, day, timezone, subjectKey, connected, liveMode, liveHints } = useWorkGraphSource({ subject, day: wantedDay, onEnvelope });
  const [selection, setSelection] = useState<WorkGraphSelection>(null);
  const [viewport, setViewport] = useState<WorkGraphViewport>({ x: 0, y: 0, zoom: 1 });
  const [view, setView] = useState<WorkActivityView | undefined>(undefined);
  const [visible, setVisible] = useState<WorkActivityWindow | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t); }, []);
  useEffect(() => { setSelection(null); setView(undefined); setVisible(undefined); }, [subjectKey, day]);

  const nodes = useMemo(() => Object.values(result.graph.nodes), [result.graph.nodes]);
  const edges = useMemo(() => Object.values(result.graph.edges), [result.graph.edges]);
  const sources = useMemo(() => Object.values(result.graph.sources), [result.graph.sources]);
  // The header every mount gets identically: who/what this graph is about, the
  // day and whether it is live (the caption), the kinds on the canvas with the
  // item/link counts (the library's legend), and the activities control.
  const people = useMemo(() => (result.graph.activity?.details ?? []).flatMap(d => d.participants ?? []), [result.graph.activity]);
  const heading = useMemo(() => workGraphHeading({
    subject, subjectKey, nodes: result.graph.nodes, people, day, timezone, ...(title ? { title } : {}),
    live: !connected ? 'off' : liveMode === 'stream' ? 'stream' : 'hints',
  }), [subjectKey, result.graph.nodes, people, day, timezone, title, connected, liveMode]); // eslint-disable-line react-hooks/exhaustive-deps
  const activity = useMemo(() => workGraphPresentation({
    graph: result.graph, day, timezone, now, mode,
    ...(visible ? { window: visible } : {}), ...(view ? { view } : {}),
    title: heading.title, subtitle: heading.subtitle, kindLegend: true,
    ...(onPopOut ? { onPopOut } : {}),
    onWindowChange: setVisible, onViewChange: setView,
  }), [result.graph, day, timezone, now, mode, visible, view, heading, onPopOut]);

  // Reported once per node set (a host's inline callback does not re-fire it).
  const nodesRef = useRef(onNodes);
  nodesRef.current = onNodes;
  useEffect(() => {
    nodesRef.current?.(nodes.map(n => ({ id: n.id, title: n.title, kind: n.kind, href: workGraphNodeHref(n.id, result.graph.edges, result.graph.nodes) })));
  }, [nodes]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = useCallback((target: Exclude<WorkGraphSelection, null>) => {
    if (target.kind !== 'node') return;
    const href = workGraphNodeHref(target.id, result.graph.edges, result.graph.nodes);
    const node = result.graph.nodes[target.id];
    if (onOpenNode && node) { onOpenNode({ id: node.id, title: node.title, kind: node.kind }, href); return; }
    if (href) navigate(href);
  }, [navigate, onOpenNode, result.graph.edges, result.graph.nodes]);

  const withCursors = !!cursorChannel && connected;
  const canvas = (
      <WorkGraph
        nodes={nodes}
        edges={edges}
        sources={sources}
        selection={selection}
        viewport={viewport}
        day={day}
        timezone={timezone}
        state={workGraphViewState(result.status, result.error, nodes.length)}
        {...(result.error ? { errorMessage: result.error === 'snapshot-unavailable' ? 'This activity is unavailable to you.' : 'The activity graph could not load.' }
          : emptyMessage && nodes.length === 0 ? { errorMessage: emptyMessage } : {})}
        {...(activity ? { activity } : {})}
        background="plain"
        onSelectionChange={setSelection}
        onViewportChange={setViewport}
        onRetry={result.retry}
        onOpen={open}
        {...(onRequestCollaboration ? { onRequestCollaboration } : {})}
        {...(onReference ? { onReference } : {})}
        className={withCursors ? 'h-full min-h-0 w-full' : className}
      />
  );
  return (
    <>
      {liveHints}
      {withCursors ? <CursorLayer channel={cursorChannel} className={className}>{canvas}</CursorLayer> : canvas}
    </>
  );
}
