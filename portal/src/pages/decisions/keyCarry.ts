// Keys typed between a keypad pick and the moment the reason field takes the
// focus (the demo-moments journey, M2: "2" then Enter at once decided nothing).
//
// A pick in the decision dialogue (decisionDialogue.ts) swaps the numbered rows
// for the chosen row's follow-up, whose one-line reason field takes the focus a
// render later. A quick hand types the next key into that gap: an Enter meant
// "decide without a reason", letters meant the reason. Nothing had the focus,
// so the page swallowed them. The carry holds them instead:
//
//   arm()       the dialogue's pick opens the gap
//   key(k)      while armed: a printable key is the reason's next character,
//               Backspace takes one back, Enter means "send it"; each is held
//               ('held': the page must not act on it). Escape and modified keys
//               (Ctrl, Cmd, Alt) pass and end the carry; so does any key once
//               Enter was held (the answer is on its way).
//   land()      the reason field took the focus: what to type into it and
//               whether to press Enter there, then the carry is idle again.
//   drop()      nothing took the focus within CARRY_MS: forget it.
//
// Pure, no DOM: useKeyCarry.ts listens on the page and delivers what lands.

export interface CarryKey {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

export interface Landed {
  /** Typed before the focus landed: goes into the reason field. */
  text: string;
  /** Enter was pressed: answer the follow-up once the text is in (an empty reason decides without one). */
  submit: boolean;
}

/** How long a carry waits for a field to take the focus before it is forgotten. */
export const CARRY_MS = 3000;

export interface KeyCarry {
  /** `now`: when the pick happened (ms), for `expired`. */
  arm(now?: number): void;
  readonly armed: boolean;
  /** Armed for longer than CARRY_MS at `now`. */
  expired(now: number): boolean;
  key(k: CarryKey): 'held' | 'pass';
  land(): Landed | null;
  drop(): void;
}

export function createKeyCarry(): KeyCarry {
  let armed = false;
  let text = '';
  let submit = false;
  let armedAt = 0;
  const reset = () => { armed = false; text = ''; submit = false; };
  return {
    arm(now = Date.now()) { armed = true; text = ''; submit = false; armedAt = now; },
    get armed() { return armed; },
    expired(now) { return armed && now - armedAt > CARRY_MS; },
    key(k) {
      if (!armed) return 'pass';
      if (k.ctrlKey || k.metaKey || k.altKey || k.key === 'Escape') { reset(); return 'pass'; }
      // Enter was held: the answer goes as it stood; later keys are not part of it.
      if (submit) return 'pass';
      if (k.key === 'Enter') { submit = true; return 'held'; }
      if (k.key === 'Backspace') { text = text.slice(0, -1); return 'held'; }
      if (k.key.length === 1) { text += k.key; return 'held'; }
      // Tab, arrows, Shift alone: not the reason's; leave them to the page.
      return 'pass';
    },
    land() {
      if (!armed) return null;
      const out = { text, submit };
      reset();
      return out;
    },
    drop: reset,
  };
}
