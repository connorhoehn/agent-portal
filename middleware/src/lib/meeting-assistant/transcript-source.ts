// Where captions come from (docs/meeting-assistant-design.md, "Architecture", intake).
//
// `TranscriptSource` is the seam: the mock source is fed by the dev injector route
// (routes/meeting-assistant-dev.ts); the Redis source (captions:<channelArn>, with the join-record
// lookup in platform-api) is package 6 and is NOT built here. Without a mock world the source is
// `notConfiguredTranscriptSource()`, which refuses to subscribe with a plain error, so an invite in a
// process that cannot hear anything fails loudly instead of "listening" to nothing.
import { config } from '../../config.js';
import type { RawLine } from './types.js';

export type TranscriptHandler = (callId: string, caption: RawLine) => void | Promise<void>;
export type Unsubscribe = () => void;

export interface TranscriptSource {
  readonly kind: 'mock' | 'not-configured';
  subscribe(callId: string, handler: TranscriptHandler): Unsubscribe;
}

export class TranscriptSourceNotConfigured extends Error {
  constructor() { super('Live captions are not configured for this deployment'); this.name = 'TranscriptSourceNotConfigured'; }
}

/**
 * True only in a non-production process running the mock providers: the same two conditions as the
 * mock control plane (routes/mock-control.ts `mockControlEnabled`), read at call time. Everything
 * mock-only in this feature (the injector route, the mock source) hangs off this one test.
 */
export function mockTranscriptEnabled(): boolean {
  if (process.env['NODE_ENV'] === 'production') return false;
  return Boolean(config.mock?.aurora || config.mock?.agentcore);
}

export class MockTranscriptSource implements TranscriptSource {
  readonly kind = 'mock' as const;
  private readonly handlers = new Map<string, Set<TranscriptHandler>>();

  subscribe(callId: string, handler: TranscriptHandler): Unsubscribe {
    const set = this.handlers.get(callId) ?? new Set<TranscriptHandler>();
    set.add(handler);
    this.handlers.set(callId, set);
    return () => {
      set.delete(handler);
      if (!set.size) this.handlers.delete(callId);
    };
  }

  /** Deliver one caption to the call's subscribers. Returns how many received it (0: nobody is listening). */
  async inject(callId: string, caption: RawLine): Promise<number> {
    const set = [...(this.handlers.get(callId) ?? [])];
    for (const handler of set) await handler(callId, caption);
    return set.length;
  }
}

export function notConfiguredTranscriptSource(): TranscriptSource {
  return { kind: 'not-configured', subscribe() { throw new TranscriptSourceNotConfigured(); } };
}

let mockSource: MockTranscriptSource | null = null;
let override: TranscriptSource | null = null;

/** The process's one mock source (the injector writes to it; the intake reads from it). */
export function theMockTranscriptSource(): MockTranscriptSource { return (mockSource ??= new MockTranscriptSource()); }
export function setTranscriptSource(next: TranscriptSource | null): void { override = next; }
export function transcriptSource(): TranscriptSource {
  if (override) return override;
  return mockTranscriptEnabled() ? theMockTranscriptSource() : notConfiguredTranscriptSource();
}
