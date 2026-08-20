// A real terminal into a devbox.
//
// xterm.js speaking the AgentCore shell protocol directly to AWS over a
// presigned WebSocket. The middleware only mints the URL; terminal frames
// never pass through it, which keeps a 250 frames/sec stream off the Node
// event loop and removes a hop from every keystroke.
//
// Wire format is Kubernetes' v5.channel.k8s.io: one channel byte, then the
// payload. Implemented here with Uint8Array rather than importing the AWS
// SDK's framer, which is Node-only (it uses Buffer) — the format is a single
// leading byte, so a browser-native version is smaller than the polyfill.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * Channel bytes. Server→client: 1,2,3. Client→server: 0,4,5. Either: 0xff.
 *
 * Source of truth is `src/runtime/shell/protocol.ts` in
 * aws/bedrock-agentcore-sdk-typescript. Mirrored here rather than imported
 * because that package is Node-only and peer-depends on an agent framework.
 * If a frame ever decodes wrong, diff against that file first.
 */
const CH = {
  STDIN: 0x00,
  STDOUT: 0x01,
  STDERR: 0x02,
  STATUS: 0x03,
  RESIZE: 0x04,
  HEARTBEAT: 0x05,
  CLOSE: 0xff,
} as const;

const MAX_FRAME = 65_536;
/** Ctrl-] detaches: drop the socket, leave the shell alive. */
const DETACH = 0x1d;
const HEARTBEAT_MS = 30_000;
/** Bounded: a quota rejection never clears by retrying. */
const MAX_RETRIES = 5;

type Phase = 'idle' | 'connecting' | 'live' | 'detached' | 'closed' | 'error';

interface Props {
  sessionId: string;
  /** Stable id so a reload reattaches to the same PTY. */
  shellId?: string;
  label?: string;
  /** Directory to cd into once the PTY is live. */
  cwd?: string;
  onExit?: (code: number | null) => void;
  height?: number;
  /** Hide the built-in header — the dock draws its own tab strip. */
  chrome?: boolean;
  /** Fill the parent instead of using a fixed height (for the dock). */
  fillHeight?: boolean;
  /** Connect on mount rather than waiting for a click. */
  autoConnect?: boolean;
  /**
   * Activity reporting for the dock's status dots. `sawOutput` is true when
   * this call was triggered by bytes arriving, which is what marks an
   * unattended pane as unread.
   */
  onStatus?: (status: 'connecting' | 'ready' | 'busy' | 'detached' | 'error', sawOutput?: boolean) => void;
}

/**
 * How to react to a close code.
 *
 * Two must NOT retry: 1003 means we sent text on a binary-only socket, so
 * reconnecting repeats the mistake; 4000 means another client claimed this
 * shell, and retrying would have two operators fighting over one terminal.
 */
function closeAdvice(code: number): { retry: boolean; text: string } {
  switch (code) {
    case 1000: return { retry: false, text: 'shell exited' };
    case 1001: return { retry: true, text: 'server going away — reconnecting' };
    case 1003: return { retry: false, text: 'protocol error (binary frames only)' };
    case 1006: return { retry: true, text: 'connection lost — reconnecting' };
    case 1008: return { retry: true, text: 'session limit reached — reconnecting' };
    case 1009: return { retry: false, text: 'frame too large — paste under 64 KB' };
    case 1011: return { retry: true, text: 'server error — reconnecting' };
    case 4000: return { retry: false, text: 'attached from another client' };
    default: return { retry: false, text: `closed (${code})` };
  }
}

function frame(channel: number, payload?: Uint8Array): Uint8Array {
  const body = payload ?? new Uint8Array(0);
  const out = new Uint8Array(body.length + 1);
  out[0] = channel;
  out.set(body, 1);
  return out;
}

export function DevboxTerminal({
  sessionId, shellId, label, onExit, height = 460,
  chrome = true, fillHeight = false, autoConnect = false, onStatus, cwd,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const shellIdRef = useRef<string | undefined>(shellId);
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // Output settles into "ready" after a quiet moment. There is no busy frame
  // in the protocol, so this is inferred from traffic — a command that prints
  // nothing will look idle, which is a limit worth stating rather than hiding.
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retriesRef = useRef(0);
  const detachedRef = useRef(false);
  // A pending reconnect has to be cancellable. Without this, unmounting during
  // backoff still fires connect(): it mints a fresh URL and opens a socket
  // nobody is watching, which silently consumes one of the 10 shell slots per
  // runtime and sets state on a disposed terminal.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [status, setStatus] = useState<string>('');

  const connect = useCallback(async () => {
    const term = termRef.current;
    if (!term || disposedRef.current) return;
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    setPhase('connecting');
    setStatus('');

    let url: string;
    try {
      const res = await fetch(`/api/devbox/${sessionId}/shell-url`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(shellIdRef.current ? { shellId: shellIdRef.current } : {}),
      });
      const body = await res.json() as { url?: string; shellId?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? `HTTP ${res.status}`);
      url = body.url;
      if (body.shellId) shellIdRef.current = body.shellId;
    } catch (err) {
      setPhase('error');
      setStatus((err as Error).message);
      onStatusRef.current?.('error');
      return;
    }

    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      retriesRef.current = 0;
      detachedRef.current = false;
      setPhase('live');
      onStatusRef.current?.('ready');
      // Tell the PTY how big it is, or output wraps at the server's default.
      const fit = fitRef.current;
      if (fit) {
        fit.fit();
        const { cols, rows } = term;
        ws.send(frame(CH.RESIZE, new TextEncoder().encode(JSON.stringify({ width: cols, height: rows }))));
      }
      // Land where the shell was opened from. Sent as a normal line so the
      // shell records it and the prompt reflects the directory — a silent
      // chdir would leave the prompt lying about where you are.
      if (cwd) {
        ws.send(frame(CH.STDIN, new TextEncoder().encode(`cd ${cwd} 2>/dev/null || true\n`)));
      }
      term.focus();
    };

    ws.onmessage = (ev) => {
      const bytes = new Uint8Array(ev.data as ArrayBuffer);
      if (bytes.length === 0) return;
      const channel = bytes[0];
      const payload = bytes.subarray(1);

      if (channel === CH.STDOUT || channel === CH.STDERR) {
        term.write(payload);
        onStatusRef.current?.('busy', true);
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => onStatusRef.current?.('ready'), 700);
        return;
      }
      if (channel === CH.STATUS) {
        try {
          const body = JSON.parse(new TextDecoder().decode(payload)) as {
            metadata?: { shellId?: string; reconnected?: boolean; bytesDropped?: number };
            details?: { causes?: Array<{ reason?: string; message?: string }> };
          };
          if (body.metadata?.shellId) {
            shellIdRef.current = body.metadata.shellId;
            const dropped = body.metadata.bytesDropped;
            setStatus(
              body.metadata.reconnected
                ? `reattached${dropped ? ` · ${dropped} bytes lost while away` : ''}`
                : 'new shell',
            );
            return;
          }
          const causes = body.details?.causes ?? [];
          const raw = causes.find((c) => c.reason === 'ExitCode')?.message;
          const code = raw == null ? null : Number.parseInt(raw, 10);
          onExitRef.current?.(Number.isNaN(code as number) ? null : code);
        } catch { /* a malformed status frame is not worth killing the terminal */ }
        return;
      }
      if (channel === CH.CLOSE) ws.close();
    };

    ws.onclose = (ev) => {
      wsRef.current = null;
      if (detachedRef.current) {
        setPhase('detached');
        setStatus('detached — shell still running');
        onStatusRef.current?.('detached');
        return;
      }

      const advice = closeAdvice(ev.code);
      setStatus(advice.text);
      if (advice.retry && retriesRef.current < MAX_RETRIES && !disposedRef.current) {
        retriesRef.current += 1;
        setPhase('connecting');
        // Backoff, because 1008 can mean we are being rate limited and an
        // immediate retry would earn another one.
        retryTimerRef.current = setTimeout(() => { void connect(); },
          Math.min(500 * 2 ** retriesRef.current, 8000));
      } else {
        setPhase(ev.code === 1000 ? 'closed' : 'error');
        onStatusRef.current?.('error');
        // A runtime already holding 10 shells rejects the upgrade, and
        // a failed upgrade reaches the browser as 1006 — indistinguishable
        // from a dropped network. Retrying will never clear a quota, so once
        // the attempts are spent, say what it might actually be.
        if (ev.code === 1006 && retriesRef.current >= MAX_RETRIES) {
          setStatus('could not connect — the runtime may already hold 10 shells; close one and retry');
        }
      }
    };

    ws.onerror = () => { /* close carries the actionable code; error does not */ };
    // onExit is read through a ref so an inline arrow in the parent does not
    // rebuild connect() on every render.
  }, [sessionId]);

  // Terminal instance, created once per mount.
  useEffect(() => {
    if (!hostRef.current) return;
    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontSize: 12.5,
      fontFamily: '"Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      theme: { background: '#0d1117', foreground: '#e6edf3', cursor: '#7ee787' },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const onData = term.onData((data) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const bytes = new TextEncoder().encode(data);
      // Ctrl-] detaches rather than reaching the shell — matches the CLI, and
      // is NOT the 0xff close frame, which would kill the PTY outright.
      if (bytes.length === 1 && bytes[0] === DETACH) {
        detachedRef.current = true;
        ws.close();
        return;
      }
      if (bytes.length > MAX_FRAME) {
        term.write('\r\n\x1b[33m[paste too large — split into chunks under 64 KB]\x1b[0m\r\n');
        return;
      }
      ws.send(frame(CH.STDIN, bytes));
    });

    const onResize = term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(frame(CH.RESIZE, new TextEncoder().encode(JSON.stringify({ width: cols, height: rows }))));
      }
    });

    const refit = () => fit.fit();
    window.addEventListener('resize', refit);

    const beat = setInterval(() => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) ws.send(frame(CH.HEARTBEAT));
    }, HEARTBEAT_MS);

    return () => {
      disposedRef.current = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      clearInterval(beat);
      window.removeEventListener('resize', refit);
      onData.dispose();
      onResize.dispose();
      // Closing the socket detaches; it deliberately does not send 0xff, so
      // the shell survives for the next attach.
      wsRef.current?.close();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    // A tab the dock just opened should already be connecting. Guarded on
    // phase so a manual disconnect is not immediately undone.
    if (autoConnect && phase === 'idle') void connect();
  }, [autoConnect, phase, connect]);

  const detach = () => {
    detachedRef.current = true;
    wsRef.current?.close();
  };

  /** Explicit kill — 0xff is permanent, the PTY cannot be reattached after it. */
  const kill = () => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(frame(CH.CLOSE));
  };

  const live = phase === 'live';
  return (
    <div className={`flex flex-col bg-[#0d1117] ${
      fillHeight ? 'h-full min-h-0' : 'rounded-lg overflow-hidden border border-[#30363d]'}`}>
      {chrome && (
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[#30363d]">
        <span className="text-[11px] font-semibold text-[#e6edf3]">{label ?? 'terminal'}</span>
        <span className={`text-[10px] ${live ? 'text-[#7ee787]' : phase === 'error' ? 'text-[#f85149]' : 'text-[#8b949e]'}`}>
          {phase}{status ? ` · ${status}` : ''}
        </span>
        <div className="flex-1" />
        {shellIdRef.current && (
          <span className="text-[9.5px] text-[#8b949e] font-mono hidden md:inline">{shellIdRef.current}</span>
        )}
        {live ? (
          <>
            <button onClick={detach} title="Leave the shell running (Ctrl-])"
              className="text-[10px] px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#e6edf3] cursor-pointer bg-transparent">
              detach
            </button>
            <button onClick={kill} title="Kill the shell — cannot be reattached"
              className="text-[10px] px-2 py-0.5 rounded border border-[#30363d] text-[#8b949e] hover:text-[#f85149] cursor-pointer bg-transparent">
              kill
            </button>
          </>
        ) : (
          <button onClick={() => void connect()}
            className="text-[10px] px-2 py-0.5 rounded border border-[#30363d] text-[#7ee787] hover:bg-[#161b22] cursor-pointer bg-transparent">
            {phase === 'detached' || phase === 'closed' ? 'reattach' : 'connect'}
          </button>
        )}
      </div>
      )}
      {/* When chrome is hidden the dock still needs the connection state, so
          it surfaces as a thin strip rather than disappearing entirely. */}
      {!chrome && phase !== 'live' && (
        <div className="px-3 py-1 text-[10px] border-b border-[#30363d] flex items-center gap-2">
          <span className={phase === 'error' ? 'text-[#f85149]' : 'text-[#8b949e]'}>
            {phase}{status ? ` · ${status}` : ''}
          </span>
          {(phase === 'idle' || phase === 'detached' || phase === 'closed' || phase === 'error') && (
            <button onClick={() => void connect()}
              className="text-[#7ee787] bg-transparent border-none cursor-pointer p-0 hover:underline">
              {phase === 'idle' ? 'connect' : 'reattach'}
            </button>
          )}
        </div>
      )}
      <div
        ref={hostRef}
        style={fillHeight ? undefined : { height }}
        className={`px-2 py-1 ${fillHeight ? 'flex-1 min-h-0' : ''}`}
      />
    </div>
  );
}
