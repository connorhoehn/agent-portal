import type { BrowserContext } from '@playwright/test';

// The shell's pre-join step (the library call host, keyed in components/shell/ShellCallHost.tsx PRE_JOIN_KEY) is
// skipped once a person ticks "remember". Specs that are about something else
// than the device check seed that choice so their Huddle/Start/Accept clicks
// reach the call directly; specs about the check itself pass 'show'.
export const PRE_JOIN_KEY = 'orgiq.call-prejoin.v1';
export type PreJoinMode = 'remembered' | 'show';

export async function seedPreJoin(context: BrowserContext, mode: PreJoinMode = 'remembered') {
  if (mode === 'show') return;
  await context.addInitScript(([key]) => {
    try { if (!window.localStorage.getItem(key!)) window.localStorage.setItem(key!, JSON.stringify({ micOn: true, cameraOn: true, remember: true })); } catch { /* storage unavailable */ }
  }, [PRE_JOIN_KEY]);
}
