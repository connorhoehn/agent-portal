// The runs fixture (docs/interviews-tenant-plan.md row I4.4, I5.1): the mock world's interview_runs table.
//
// Each finished technical round (Mateo's and Ingrid's coding rounds with Hugo, Ravi's with Wen) holds two runs on the
// round's own timeline, one that fails and one that passes, so the record page has runs to jump to beside the pad log
// (mock/interviews-pad-log.ts) and the transcript (mock/interviews-records.ts). A walk that starts a run in a live
// round adds to this and resets the world after. Registered from its own module (lib/interviews/runs/store.ts imports
// it), so mock/interviews.ts is untouched. `POST /api/__mock/reset` resets it like every other fixture.
import { defineFixture } from './core/index.js';
import { seedAt } from './interviews-days.js';
import type { RunRecord } from '../lib/interviews/runs/store.js';
import { LIVE_INTERVIEW_ID, liveStart } from './interviews.js';
import type { RunLanguage, RunResult, RunStatus } from '../lib/interviews/runs/executor.js';

/** Seconds after a round's start (`days` working days from today, at `hour` UTC). */
const atFor = (days: number, hour: number, seconds: number): string => seedAt(days, hour, 0, seconds);

interface Seed {
  interviewId: string; days: number; hour: number; /** When set, `s` counts from this instant instead of `days` / `hour`. */ base?: string; runId: string; language: RunLanguage; entrypoint: string;
  by: { id: string; name: string; side: 'panel' | 'candidate' }; s: number; status: RunStatus;
  stdout: string; stderr: string; exitCode: number; timeMs: number; version: string; source: string;
}

function run(x: Seed): RunRecord {
  const from = (seconds: number) => (x.base ? new Date(Date.parse(x.base) + seconds * 1000).toISOString() : atFor(x.days, x.hour, seconds));
  const queuedAt = from(x.s);
  const endedAt = from(x.s + Math.ceil(x.timeMs / 1000) + 1);
  const result: RunResult = {
    status: x.status, exitCode: x.exitCode, compileOutput: '', stdout: x.stdout, stderr: x.stderr, truncated: { stdout: false, stderr: false },
    timeMs: x.timeMs, peakMemoryMb: 28, backend: 'mock', runtimeVersion: x.version,
  };
  return {
    interviewId: x.interviewId, runId: x.runId, language: x.language, entrypoint: x.entrypoint, files: [{ path: x.entrypoint, bytes: x.source.length }],
    source: [{ path: x.entrypoint, content: x.source }], stdin: null, startedBy: x.by, status: x.status, queuedAt, startedAt: queuedAt, endedAt,
    result, events: [], holdId: null, spendSourceId: null,
  };
}

const PY = 'Python 3.12.7';
const SWIFT = 'Swift 5.10';
const HUGO = { id: 'u-hugo', name: 'Hugo Marchetti', side: 'panel' as const };
const WEN = { id: 'u-wen', name: 'Wen Zhao', side: 'panel' as const };
const cand = (interviewId: string, name: string) => ({ id: `guest:${interviewId}`, name, side: 'candidate' as const });

const LIMITER_FAILS = 'limiter = RateLimiter(3, 1.0)\nresults = [limiter.allow("key-a", 0.0) for _ in range(5)]\nassert results == [True, True, True, False, False], results\nprint("ok")\n';
const LIMITER_PASSES = 'limiter = RateLimiter(3, 1.0)\nresults = [limiter.allow("key-a", 0.0) for _ in range(5)]\nassert results == [True, True, True, False, False], results\nprint(results)\nprint("ok")\n';
const LIMITER_KEYLESS = 'limiter = RateLimiter(3, 1.0)\nresults = [limiter.allow(0.0) for _ in range(5)]\nassert results == [True, True, True, False, False], results\nprint("ok")\n';
const LIMITER_KEYLESS_OK = 'limiter = RateLimiter(3, 1.0)\nresults = [limiter.allow(0.0) for _ in range(5)]\nassert results == [True, True, True, False, False], results\nprint(results)\nprint("ok")\n';
const RETRY_CHECK = 'provider = FlakyProvider(fail_first=2)\nprint(charge_with_retry(provider, 4200, "tok_test"))\nprint(provider.calls)\n';

export const interviewRunsFixture = defineFixture<RunRecord>({
  key: 'interviews.runs',
  scenarios: {
    default: () => [
      // Mateo (-3d 14:00): the limiter fails on the first run, passes after the fix; the retry runs once, with the same key each time.
      run({ interviewId: 'iv-j6x2d9sb', days: -3, hour: 14, runId: 'run-mateo-01', language: 'python', entrypoint: 'main.py', by: cand('iv-j6x2d9sb', 'Mateo'), s: 720, status: 'failed',
        stdout: '', stderr: 'Traceback (most recent call last):\n  File "main.py", line 3, in <module>\n    assert results == [True, True, True, False, False], results\nAssertionError: [True, True, True, True, True]\n', exitCode: 1, timeMs: 180, version: PY, source: LIMITER_FAILS }),
      run({ interviewId: 'iv-j6x2d9sb', days: -3, hour: 14, runId: 'run-mateo-02', language: 'python', entrypoint: 'main.py', by: cand('iv-j6x2d9sb', 'Mateo'), s: 860, status: 'succeeded',
        stdout: '[True, True, True, False, False]\nok\n', stderr: '', exitCode: 0, timeMs: 150, version: PY, source: LIMITER_PASSES }),
      // Ingrid's coding round (-9d 14:00).
      run({ interviewId: 'iv-d7q4n9xe', days: -9, hour: 14, runId: 'run-ingrid-01', language: 'python', entrypoint: 'main.py', by: cand('iv-d7q4n9xe', 'Ingrid'), s: 770, status: 'failed',
        stdout: '', stderr: 'Traceback (most recent call last):\n  File "main.py", line 1, in <module>\n    limiter = RateLimiter(3, 1.0)\nTypeError: RateLimiter.allow() missing 1 required positional argument: \'now\'\n', exitCode: 1, timeMs: 120, version: PY, source: LIMITER_FAILS }),
      run({ interviewId: 'iv-d7q4n9xe', days: -9, hour: 14, runId: 'run-ingrid-02', language: 'python', entrypoint: 'main.py', by: HUGO, s: 960, status: 'succeeded',
        stdout: '[True, True, True, False, False]\nok\n', stderr: '', exitCode: 0, timeMs: 140, version: PY, source: LIMITER_PASSES }),
      run({ interviewId: 'iv-d7q4n9xe', days: -9, hour: 14, runId: 'run-ingrid-03', language: 'python', entrypoint: 'main.py', by: cand('iv-d7q4n9xe', 'Ingrid'), s: 2090, status: 'succeeded',
        stdout: 'ch_4200_ok\n3\n', stderr: '', exitCode: 0, timeMs: 410, version: PY, source: RETRY_CHECK }),
      // Ravi's coding round (-2d 15:00), in Swift.
      run({ interviewId: 'iv-p2v7j4ye', days: -2, hour: 15, runId: 'run-ravi-01', language: 'swift', entrypoint: 'main.swift', by: cand('iv-p2v7j4ye', 'Ravi'), s: 880, status: 'failed',
        stdout: '', stderr: 'main.swift:12: Fatal error: page 2 was requested twice\n', exitCode: 1, timeMs: 620, version: SWIFT, source: 'let model = FeedModel()\nmodel.loadMoreIfNeeded(after: model.items[0])\nmodel.loadMoreIfNeeded(after: model.items[0])\n' }),
      run({ interviewId: 'iv-p2v7j4ye', days: -2, hour: 15, runId: 'run-ravi-02', language: 'swift', entrypoint: 'main.swift', by: WEN, s: 2520, status: 'succeeded',
        stdout: 'search "swi" cancelled\nsearch "swift" returned 3 results\n', stderr: '', exitCode: 0, timeMs: 710, version: SWIFT, source: 'let model = SearchModel()\nmodel.queryChanged("swi")\nmodel.queryChanged("swift")\n' }),
      // Kwame's coding round, live now (mock/interviews.ts LIVE_INTERVIEW_ID): the first run fails the five-call check
      // (the bucket lets only two through), the second passes after the one-character fix.
      run({ interviewId: LIVE_INTERVIEW_ID, days: 0, hour: 0, base: liveStart(), runId: 'run-kwame-01', language: 'python', entrypoint: 'main.py', by: cand(LIVE_INTERVIEW_ID, 'Kwame'), s: 270, status: 'failed',
        stdout: '', stderr: 'Traceback (most recent call last):\n  File "main.py", line 3, in <module>\n    assert results == [True, True, True, False, False], results\nAssertionError: [True, True, False, False, False]\n',
        exitCode: 1, timeMs: 130, version: PY, source: LIMITER_KEYLESS }),
      run({ interviewId: LIVE_INTERVIEW_ID, days: 0, hour: 0, base: liveStart(), runId: 'run-kwame-02', language: 'python', entrypoint: 'main.py', by: cand(LIVE_INTERVIEW_ID, 'Kwame'), s: 470, status: 'succeeded',
        stdout: '[True, True, True, False, False]\nok\n', stderr: '', exitCode: 0, timeMs: 140, version: PY, source: LIMITER_KEYLESS_OK }),
    ],
    empty: () => [],
  },
});
