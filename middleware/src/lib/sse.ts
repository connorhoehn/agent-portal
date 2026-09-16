import type { Response } from 'express';

export function initSSE(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Send the headers NOW rather than with the first body write.
  //
  // `writeHead` only stages them; Node flushes on the first `write()` or
  // `end()`. A stream that opens with an empty replay buffer therefore writes
  // nothing until the 25s heartbeat below — so the browser's EventSource sits
  // in CONNECTING, `onopen` never fires, and the page reports itself as not
  // connected for twenty-five seconds at a time while the server is perfectly
  // healthy and holding the socket open.
  //
  // Invisible wherever a stream has a backlog to replay, which is why it went
  // unnoticed: the authz log always has recent decisions and flushed on its
  // first row. The approvals queue is empty whenever nothing is blocked —
  // the normal, good state — so that page showed "connecting…" essentially
  // always. Found by curling both: the authz stream returned headers, the
  // approvals stream returned none.
  res.flushHeaders();
  // Heartbeat keeps the connection alive across vite proxies / load balancers
  // that close idle HTTP sockets. SSE comment lines are ignored by EventSource.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    // A NAMED event, not a comment: EventSource ignores comment lines, so a
    // client could never tell a healthy quiet stream from a zombie one. A
    // dev proxy (Vite's) keeps the browser's socket open after the upstream
    // dies, so no onerror ever fires — the client watches for this event
    // and reconnects itself when it stops arriving.
    res.write(`event: heartbeat\ndata: {"ts":${Date.now()}}\n\n`);
  }, 25_000);
  res.once('close', () => clearInterval(heartbeat));
  // A socket reset mid-write (heartbeat tick or a writeSSE call) emits
  // 'error' on the Writable; Node throws an uncaught exception at the
  // process level if nothing is listening for it. Clear the heartbeat the
  // same as on 'close' and swallow — the client is gone either way, this
  // just keeps a dead peer from taking the whole middleware process down.
  res.on('error', () => clearInterval(heartbeat));
}

export function writeSSE(res: Response, data: unknown, id?: string | number): void {
  if (!res.writableEnded) {
    if (id !== undefined) res.write(`id: ${id}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

export function endSSE(res: Response): void {
  if (!res.writableEnded) {
    res.end();
  }
}
