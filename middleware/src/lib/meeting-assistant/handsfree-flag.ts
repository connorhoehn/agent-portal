// MEETING_ASSISTANT_HANDSFREE=1: a call's Milo runs hands-free (handsfree/: one transcription stream per consenting person, a
// talking session that hears only the person who said his name, the hold button on the same route). Off by default: today's
// room-mix path runs unchanged.
//
// Read ONCE PER CALL, by `AssistantRuntime.start` (orchestrator.ts), and the answer is kept on that call's run for its whole life:
// a call never switches paths mid-run, and flipping the environment affects only calls started afterwards. Nothing caches the value
// between calls, so tests and a restarted dev server see the environment as it is now. Allowed in every environment (it is a
// rollout switch, not a paid-check switch like MEETING_ASSISTANT_LIVE); the flag goes once the live gate and the film pass.

/** Whether a call starting now runs hands-free. True only for `1` or `true` (surrounding spaces ignored); anything else is off. */
export function handsfreeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['MEETING_ASSISTANT_HANDSFREE'] ?? '').trim();
  return v === '1' || v === 'true';
}
