// The sweeps start whether or not the feature flag is on, and never throw when the tables are missing (audit M4).
import fs from 'node:fs';
import path from 'node:path';
let enabled = false;
jest.mock('../../../config.js', () => ({ config: { mock: { aurora: true }, get meetingAssistant() { return { enabled, transcriptRetentionDays: 30 }; } } }));
import { MemoryAssistantStore } from '../store.js';
import { setAssistantStore } from '../store-select.js';
import { startMeetingAssistantSweeps } from '../sweeps.js';

describe('the sweeps start with the flag off', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('runs retention and turn expiry on their timers, flag off, on empty tables', async () => {
    enabled = false;
    const store = new MemoryAssistantStore(); setAssistantStore(store);
    const sweepLines = jest.spyOn(store, 'sweepLines'); const dueTurns = jest.spyOn(store, 'dueTurns');
    const stop = startMeetingAssistantSweeps();
    await jest.advanceTimersByTimeAsync(3_600_000);
    expect(sweepLines).toHaveBeenCalled();
    expect(dueTurns).toHaveBeenCalled();
    stop();
    setAssistantStore(null);
  });

  it('a missing table logs once per sweep and never throws', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new MemoryAssistantStore(); setAssistantStore(store);
    const missing = new Error('relation "meeting_assistants" does not exist');
    jest.spyOn(store, 'sweepLines').mockRejectedValue(missing); jest.spyOn(store, 'dueTurns').mockRejectedValue(missing);
    const stop = startMeetingAssistantSweeps();
    await jest.advanceTimersByTimeAsync(3_600_000 * 3);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('retention sweep failed'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes('turn sweep failed'))).toHaveLength(1);
    stop(); warn.mockRestore(); setAssistantStore(null);
  });

  it('a starter that throws at boot is caught and the other still starts', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const turns = jest.fn(() => () => undefined);
    expect(() => startMeetingAssistantSweeps({ retention: () => { throw new Error('no store'); }, turns })).not.toThrow();
    expect(turns).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('index.ts wiring', () => {
  it('starts the sweeps outside any flag check', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../index.ts'), 'utf8');
    const at = src.indexOf('startMeetingAssistantSweeps();');
    expect(at).toBeGreaterThan(0);
    const lineStart = src.lastIndexOf('\n', at) + 1;
    expect(src.slice(lineStart, at)).toBe('');                    // a bare statement, not `if (...) startMeetingAssistantSweeps()`
    expect(src).not.toMatch(/meetingAssistantEnabled\(\)\)?\s*\{[^}]*(startRetentionSweep|startTurnSweep)/);
  });
});
