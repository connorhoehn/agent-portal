// The meeting assistant's limits, read from the environment on every call (like lib/voice/config.ts) so a test or an
// operator override needs no restart path of its own.
//   MEETING_ASSISTANT_MAX_MINUTES       listening minutes per call before Nova leaves (default 60); also what one extension adds
//   MEETING_ASSISTANT_HARD_MAX_MINUTES  the most a call can be extended to (default 180, never below the first ceiling)
//   MEETING_ASSISTANT_MAX_REQUESTS      requests Nova answers per call (default 60)
export interface AssistantLimits { maxSeconds: number; hardMaxSeconds: number; maxRequests: number }

function positive(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n > 0 ? n : fallback;
}

export function assistantLimits(): AssistantLimits {
  const maxMinutes = positive('MEETING_ASSISTANT_MAX_MINUTES', 60);
  const hardMinutes = Math.max(maxMinutes, positive('MEETING_ASSISTANT_HARD_MAX_MINUTES', 180));
  return { maxSeconds: Math.round(maxMinutes * 60), hardMaxSeconds: Math.round(hardMinutes * 60), maxRequests: Math.floor(positive('MEETING_ASSISTANT_MAX_REQUESTS', 60)) };
}

/** The warning goes out this long before the ceiling. */
export const CEILING_WARNING_SECONDS = 300;

/** A write claimed in the last seconds of its ten minutes still gets this long (from the claim) to run and report: its result is not refused as expired. */
export const WRITE_FINISH_MS = 90_000;
