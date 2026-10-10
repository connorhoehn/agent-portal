// The demo's one clock knob — how long a "beat" of the Computer Lab demo lasts.
//
// The `demo` scenario (mock/demo-director.ts) is a story told in beats: an
// agent picks up an item, a step lands in its tail, a question is asked. Every
// wait in that story — the director's own staggering, the per-event pace of
// the demo work products the fake microVM plays (mock/devbox-shell.ts), how
// long a computer spends `provisioning` — is a whole number of beats, so ONE
// env var stretches or squeezes the whole thing and nothing drifts out of step
// with anything else.
//
//   DEMO_DIRECTOR_PACE_MS   beat length in ms. Default 4000 — the story took
//                           145s at a 3s beat, so ~3¼ minutes; 0 under jest.
//                           400 tells it in ~20s, for an e2e.
//
// Read on every call, never cached, so a test can change it between cases.

/**
 * A beat asked for by the scenario request itself (`POST /api/__mock/scenario
 * {"scenario":"demo","paceMs":400}`), so an e2e can play the story fast
 * against a running server without restarting it. Wins over the env; cleared
 * when the director is reset.
 */
let paceOverride: number | null = null;
export function setDemoPaceOverride(ms: number | null): void {
  paceOverride = ms != null && Number.isFinite(ms) && ms >= 0 ? ms : null;
}

export function demoBeatMs(): number {
  if (paceOverride !== null) return paceOverride;
  const raw = process.env['DEMO_DIRECTOR_PACE_MS'];
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return process.env['NODE_ENV'] === 'test' ? 0 : 4_000;
}

/** Whether the demo director is telling its story right now. */
let active = false;
export function setDemoActive(next: boolean): void { active = next; }
export function demoActive(): boolean { return active; }

/** Sleep `beats` beats. Unref'd: a pending beat is never why a process stays up. */
export function sleepBeats(beats: number, signal?: { cancelled: boolean }): Promise<void> {
  const ms = Math.max(0, beats * demoBeatMs());
  if (ms === 0 || signal?.cancelled) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}
