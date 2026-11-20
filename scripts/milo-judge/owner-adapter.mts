// The one place the judge touches the real turn owner (middleware/src/lib/meeting-assistant/turn/turn-owner.ts, lanes 1A/1B).
//
// The plan (REBUILD-PLAN section 1) says the owner "wires listening and hold presses through the steps" and speaks through
// `speak.ts` (which logs via `policy.logSpoken` before any audio). The judge needs, from it, only five things:
//   start(setup)            a call with these people, their roles and declines, and this round, on `clock`
//   sentence(who, text)     a FINAL transcript line from that person's own lane       (an `echo` is the same, on the wrong lane)
//   onset(who)              that person started speaking again
//   hold(who, down)         a hold press or release
//   finish()                everything the owner logged (action + exact words + who) and every decide request it made
// Bind them in `bindOwner` below when lane 1B merges. Until then the module is absent and every scenario is "needs turn owner".
// If the module is PRESENT but `bindOwner` is not filled in, the judge fails loudly rather than skipping.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FakeClock } from './fake-clock.mts';
import type { Outcome, Scenario } from './types.mts';
import type { Rig } from './rigs.mts';

const here = dirname(fileURLToPath(import.meta.url));
export const OWNER_MODULE = resolve(here, '../../middleware/src/lib/meeting-assistant/turn/turn-owner.ts');

export const ownerPresent = (): boolean => existsSync(OWNER_MODULE);

export interface OwnerHandle {
  sentence(who: string, text: string, kind: 'sentence' | 'echo'): Promise<void>;
  onset(who: string): Promise<void>;
  hold(who: string, down: boolean): Promise<void>;
  finish(): Promise<Outcome>;
}

/** FILL IN when lane 1B merges: build the owner from its real factory with the real Decide, the registered interviews policy, the
 *  mock stores and `clock`, with a fake mouth that records instead of playing. Never a judge-side stand-in for any step. */
async function bindOwner(_mod: unknown, _s: Scenario, _clock: FakeClock): Promise<OwnerHandle> {
  throw new Error('owner adapter not bound: wire bindOwner (scripts/milo-judge/owner-adapter.mts) to the turn owner API from lane 1B');
}

export function ownerRig(clock: () => FakeClock): Rig {
  return async (s) => {
    const mod: unknown = await import(OWNER_MODULE);
    const c = clock();
    const owner = await bindOwner(mod, s, c);
    for (const ev of [...s.events].sort((a, b) => a.atMs - b.atMs)) {
      await c.advanceTo(ev.atMs);
      if (ev.kind === 'sentence' || ev.kind === 'echo') await owner.sentence(ev.who, ev.text, ev.kind);
      else if (ev.kind === 'onset') await owner.onset(ev.who);
      else await owner.hold(ev.who, ev.down);
    }
    await c.advanceTo(Math.max(...s.events.map((e) => e.atMs)) + 30_000); // let the quiet timers, the decide call and playout finish
    return owner.finish();
  };
}
