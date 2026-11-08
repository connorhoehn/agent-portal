// A fake Live API sideband socket (docs/voice-navigator-gaps.md G12), injected
// with lib/voice/openai.ts `_setVoiceWebSocket` the way `_setVoiceFetch`
// injects fetch. A socket is created when the middleware attaches and does
// nothing until the test drives it: `open()`, `frame(event)` (one server
// frame, as JSON text), `drop()` (an unexpected close), `fail()` (an error
// then a close). `close()` is the middleware closing it.

import type { SidebandSocket } from '../lib/voice/openai.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Listener = (ev: any) => void;

export class FakeSideband implements SidebandSocket {
  static sockets: FakeSideband[] = [];
  /** Runs on every new socket (e.g. fail it at once, or open it). */
  static onCreate: ((s: FakeSideband) => void) | null = null;
  static reset(): void { FakeSideband.sockets = []; FakeSideband.onCreate = null; }

  private listeners = new Map<string, Listener[]>();
  closedByClient = false;
  closeCode: number | null = null;

  constructor(readonly url: string, readonly init: { headers: Record<string, string> }) {
    FakeSideband.sockets.push(this);
    FakeSideband.onCreate?.(this);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(code?: number): void {
    if (this.closeCode != null) return;
    this.closedByClient = true;
    this.closeCode = code ?? 1005;
    this.emit('close', { code: this.closeCode });
  }

  open(): this { this.emit('open', {}); return this; }
  frame(event: Record<string, unknown>): this { this.emit('message', { data: JSON.stringify(event) }); return this; }
  drop(): void { if (this.closeCode == null) { this.closeCode = 1006; this.emit('close', { code: 1006 }); } }
  fail(): void { this.emit('error', { message: 'boom' }); this.drop(); }

  private emit(type: string, ev: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l(ev);
  }
}

/** A sideband that never opens: the mint's attach is a no-op as far as figures go. */
export class SilentSideband implements SidebandSocket {
  addEventListener(): void { /* never fires */ }
  close(): void { /* nothing to close */ }
}
