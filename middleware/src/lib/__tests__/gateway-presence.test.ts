// The status line is bounded where it is written: the gateway's presence
// feature cuts `metadata.statusMessage` to one line of at most 120 characters
// before the library stores or fans it out, whatever the client sent.
import { boundStatusMessage, boundedPresence, STATUS_MESSAGE_MAX } from '../gateway-presence.js';
import type { RealtimeFeature } from '@connorhoehn/realtime-modules/server';

describe('boundStatusMessage', () => {
  it('keeps a short line, clears empty and non-string values', () => {
    expect(boundStatusMessage('  out today ')).toBe('out today');
    expect(boundStatusMessage('')).toBeNull();
    expect(boundStatusMessage('   ')).toBeNull();
    expect(boundStatusMessage(42)).toBeNull();
    expect(boundStatusMessage({ text: 'x' })).toBeNull();
  });
  it('makes it one line without control characters and caps it', () => {
    expect(boundStatusMessage('a\nb\r\tc\u0000d\u2028e')).toBe('a b c d e');
    expect([...boundStatusMessage('y'.repeat(5000))!].length).toBe(STATUS_MESSAGE_MAX);
    expect([...boundStatusMessage('😀'.repeat(200))!].length).toBe(STATUS_MESSAGE_MAX);
  });
});

describe('boundedPresence', () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const inner: RealtimeFeature = {
    manifest: { name: 'presence' } as RealtimeFeature['manifest'],
    create: () => ({ handleAction: async (_c: string, action: string, data: Record<string, unknown>) => { calls.push([action, data]); } }) as never,
  };
  const service = boundedPresence(inner).create({} as never) as unknown as {
    handleAction: (c: string, a: string, d: Record<string, unknown>) => Promise<void>;
  };
  beforeEach(() => { calls.length = 0; });

  it('bounds the status line on every set, leaving the rest of the frame alone', async () => {
    await service.handleAction('c1', 'set', { status: 'busy', channels: ['social:lobby'], metadata: { statusMessage: `x\n${'z'.repeat(500)}`, other: 1 } });
    const [action, data] = calls[0]!;
    expect(action).toBe('set');
    expect(data['status']).toBe('busy');
    expect(data['channels']).toEqual(['social:lobby']);
    const meta = data['metadata'] as Record<string, unknown>;
    expect(meta['other']).toBe(1);
    expect(String(meta['statusMessage']).length).toBe(STATUS_MESSAGE_MAX);
    expect(String(meta['statusMessage'])).not.toContain('\n');
  });

  it('passes other actions and sets without a status line through untouched', async () => {
    const heartbeat = { channel: 'social:lobby' };
    await service.handleAction('c1', 'heartbeat', heartbeat);
    const plain = { status: 'online', metadata: { a: 1 } };
    await service.handleAction('c1', 'set', plain);
    expect(calls[0]![1]).toBe(heartbeat);
    expect(calls[1]![1]).toBe(plain);
  });
});
