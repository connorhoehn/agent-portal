// MEETING_ASSISTANT_LIVE=1: the mock world uses the provider's real live session for the meeting assistant (one paid check,
// scripts/meeting-assistant/live-e2e.mjs) while everything else stays mock. Off by default, and never in production: the
// process refuses to start with it on when NODE_ENV=production, and `liveForced()` is false there whatever the environment says.
export function liveFlagRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env['MEETING_ASSISTANT_LIVE'] ?? '').trim();
  return v === '1' || v === 'true';
}

export function liveForced(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['NODE_ENV'] !== 'production' && liveFlagRequested(env);
}

/** Start-up check: throws when the flag is on in production. */
export function assertLiveFlagAllowed(env: NodeJS.ProcessEnv = process.env): void {
  if (env['NODE_ENV'] === 'production' && liveFlagRequested(env)) {
    throw new Error('MEETING_ASSISTANT_LIVE is a local paid-check switch and may not be set when NODE_ENV=production');
  }
}
