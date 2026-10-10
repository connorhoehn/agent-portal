export interface HealthProbeStatus {
  ok: boolean;
  error?: string;
}

export interface HealthProbeSnapshot extends HealthProbeStatus {
  checkedAt?: number;
  refreshing?: boolean;
  stale?: boolean;
}

/** Diagnostics refresh independently of HTTP health polls. Never report an
 * untested dependency as healthy, or start another probe while one is pending. */
export function createHealthProbe(
  ttlMs: number,
  run: () => Promise<HealthProbeStatus>,
  summarize: (error: unknown) => string,
) {
  let cached: { status: HealthProbeStatus; checkedAt: number } | undefined;
  let pending: Promise<HealthProbeStatus> | undefined;
  let generation = 0;

  function check(): Promise<HealthProbeStatus> {
    if (cached && Date.now() - cached.checkedAt < ttlMs) return Promise.resolve({ ...cached.status });
    if (pending) return pending;
    const currentGeneration = generation;
    const work = Promise.resolve().then(run).catch(error => ({ ok: false, error: summarize(error) })).then(status => {
      if (currentGeneration === generation) cached = { status: { ...status }, checkedAt: Date.now() };
      return { ...status };
    }).finally(() => { if (pending === work) pending = undefined; });
    pending = work;
    return work;
  }

  return {
    check,
    snapshot(): HealthProbeSnapshot {
      void check();
      if (!cached) return { ok: false, error: 'CheckPending', refreshing: true };
      return { ...cached.status, checkedAt: cached.checkedAt,
        refreshing: !!pending, stale: Date.now() - cached.checkedAt >= ttlMs };
    },
    reset(): void { generation++; cached = undefined; pending = undefined; },
  };
}
