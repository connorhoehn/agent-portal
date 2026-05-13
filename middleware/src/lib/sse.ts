import type { Response } from 'express';

export function initSSE(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Heartbeat keeps the connection alive across vite proxies / load balancers
  // that close idle HTTP sockets. SSE comment lines are ignored by EventSource.
  const heartbeat = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(heartbeat);
      return;
    }
    res.write(': hb\n\n');
  }, 25_000);
  res.once('close', () => clearInterval(heartbeat));
}

export function writeSSE(res: Response, data: unknown): void {
  if (!res.writableEnded) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

export function endSSE(res: Response): void {
  if (!res.writableEnded) {
    res.end();
  }
}
