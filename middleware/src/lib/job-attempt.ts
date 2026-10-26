import { performance } from 'node:perf_hooks';
import { heartbeatJob } from '../providers/agent-jobs.js';

/** Local execution guard; SQL's live claim token remains the write authority. */
export interface JobAttempt {
  readonly signal: AbortSignal;
  assertLive(): void;
  run<T>(work: () => Promise<T>): Promise<T>;
  stop(): void;
}

/** Renew serially, and abandon execution if ownership cannot be confirmed. */
export async function maintainJobAttempt(id: string, token: string, staleMs: number): Promise<JobAttempt> {
  if (!Number.isFinite(staleMs) || staleMs <= 0) throw new Error('Job stale window must be positive');
  const controller = new AbortController();
  // Leave half the SQL stale window for clock/scheduling and transport delays.
  const leaseMs = staleMs / 2;
  const intervalMs = Math.min(10_000, leaseMs / 3);
  let deadline = performance.now() + leaseMs;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { clearTimeout(timer); clearTimeout(watchdog); };
  const lose = (reason: unknown) => {
    if (stopped || controller.signal.aborted) return;
    clear();
    controller.abort(reason instanceof Error ? reason : new Error('Job attempt lost ownership'));
  };
  const assertLive = () => {
    if (!stopped && performance.now() >= deadline) lose(new Error('Job heartbeat deadline elapsed'));
    controller.signal.throwIfAborted();
    if (stopped) throw new Error('Job attempt stopped');
  };
  const run = <T>(work: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    assertLive();
    const abort = () => reject(controller.signal.reason);
    // Attach rejection handling even when already fenced: late IO is observed.
    work().then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
    if (controller.signal.aborted) abort();
    else controller.signal.addEventListener('abort', abort, { once: true });
  });
  const armDeadline = () => {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => lose(new Error('Job heartbeat deadline elapsed')), Math.max(1, deadline - performance.now()));
    watchdog.unref?.();
  };
  const renew = async () => {
    const sentAt = performance.now();
    try {
      assertLive();
      const held = await run(() => heartbeatJob(id, token));
      if (stopped) return;
      assertLive();
      if (!held || performance.now() >= sentAt + leaseMs) throw new Error('Job attempt lost ownership');
      deadline = sentAt + leaseMs;
      armDeadline();
      timer = setTimeout(() => void renew(), intervalMs);
      timer.unref?.();
    } catch (error) { lose(error); }
  };
  armDeadline();
  await renew();
  assertLive();
  return {
    signal: controller.signal, assertLive, run,
    stop() { if (stopped) return; controller.abort(new Error('Job attempt stopped')); stopped = true; clear(); },
  };
}
