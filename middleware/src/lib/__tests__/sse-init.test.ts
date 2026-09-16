// The SSE head has to reach the client before any body byte.
//
// `res.writeHead` only STAGES headers; Node flushes them on the first
// `write()` or `end()`. Every stream in this app opens by replaying a buffer,
// so the head went out with the first replayed row and nobody noticed — until
// a stream opened with an EMPTY buffer. Then the next write was the 25-second
// heartbeat, the browser's EventSource sat in CONNECTING for that whole time,
// `onopen` never fired, and the page reported itself disconnected while the
// server was healthy and holding the socket.
//
// The approvals queue is empty whenever nothing is blocked on a person, which
// is the normal, good state — so that page read "connecting…" essentially
// always. Found by curling two streams: the authz log (which always has
// recent decisions) returned headers immediately; approvals returned none.

import { initSSE, writeSSE, endSSE } from '../sse.js';

interface FakeRes {
  writeHead: jest.Mock;
  flushHeaders: jest.Mock;
  write: jest.Mock;
  once: jest.Mock;
  on: jest.Mock;
  end: jest.Mock;
  writableEnded: boolean;
}

function fakeRes(): FakeRes {
  return {
    writeHead: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    once: jest.fn(),
    on: jest.fn(),
    end: jest.fn(),
    writableEnded: false,
  };
}

describe('initSSE', () => {
  afterEach(() => { jest.clearAllTimers(); });

  it('flushes the head immediately, before anything is written', () => {
    const res = fakeRes();
    initSSE(res as unknown as Parameters<typeof initSSE>[0]);
    expect(res.flushHeaders).toHaveBeenCalledTimes(1);
    // The load-bearing part: nothing has been written, and the head is out.
    // Without the flush the client learns the stream exists 25s later.
    expect(res.write).not.toHaveBeenCalled();
    expect(res.flushHeaders.mock.invocationCallOrder[0])
      .toBeGreaterThan(res.writeHead.mock.invocationCallOrder[0]!);
  });

  it('declares the event-stream content type and disables buffering', () => {
    const res = fakeRes();
    initSSE(res as unknown as Parameters<typeof initSSE>[0]);
    const [status, headers] = res.writeHead.mock.calls[0]! as [number, Record<string, string>];
    expect(status).toBe(200);
    expect(headers['Content-Type']).toBe('text/event-stream');
    expect(headers['Cache-Control']).toBe('no-cache');
    // Nginx and friends buffer a response body by default, which would undo
    // the flush one layer further out.
    expect(headers['X-Accel-Buffering']).toBe('no');
  });

  it('writeSSE emits one data frame and skips a finished response', () => {
    const res = fakeRes();
    writeSSE(res as unknown as Parameters<typeof writeSSE>[0], { a: 1 });
    expect(res.write).toHaveBeenCalledWith('data: {"a":1}\n\n');

    res.write.mockClear();
    res.writableEnded = true;
    writeSSE(res as unknown as Parameters<typeof writeSSE>[0], { a: 2 });
    expect(res.write).not.toHaveBeenCalled();
  });

  it('endSSE is safe to call on an already-finished response', () => {
    const res = fakeRes();
    res.writableEnded = true;
    expect(() => endSSE(res as unknown as Parameters<typeof endSSE>[0])).not.toThrow();
  });
});
