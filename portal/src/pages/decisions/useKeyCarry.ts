// The page side of keyCarry.ts: while the carry is armed (a keypad pick just
// opened the reason field), keys the page would otherwise swallow are held, and
// the first editable field that takes the focus receives them: the typed
// characters go in, and a held Enter answers the follow-up there, exactly as
// if it had been pressed in the field. A carry nothing lands within
// CARRY_MS is forgotten.

import { useEffect } from 'react';
import { CARRY_MS, type KeyCarry, type Landed } from './keyCarry';

function editable(target: EventTarget | null): target is HTMLElement {
  if (!(target instanceof HTMLElement)) return false;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable;
}

function typeInto(el: HTMLElement, text: string): void {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // The native setter, so React's onChange sees the new value.
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, el.value + text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }
  // A rich-text box: the editor's own insert path.
  document.execCommand('insertText', false, text);
}

function pressEnter(el: HTMLElement): void {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
}

/** Deliver what the carry held to the field that took the focus. */
export function deliverLanded(el: HTMLElement, landed: Landed): void {
  if (landed.text) typeInto(el, landed.text);
  if (!landed.submit) return;
  // After the typed text has reached the field's state (its input event's render), not in the same turn.
  if (landed.text) setTimeout(() => pressEnter(el), 0);
  else pressEnter(el);
}

export function useKeyCarry(carry: KeyCarry | null): void {
  useEffect(() => {
    if (!carry) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (!carry.armed) return;
      if (carry.expired(Date.now())) { carry.drop(); return; }
      // Already in a field: the keys are the field's.
      if (editable(e.target)) return;
      if (carry.key(e) === 'held') { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    const onFocus = (e: FocusEvent) => {
      if (!carry.armed || !editable(e.target)) return;
      if (carry.expired(Date.now())) { carry.drop(); return; }
      const landed = carry.land();
      if (landed && (landed.text || landed.submit)) deliverLanded(e.target, landed);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('focusin', onFocus, true);
    const timer = setInterval(() => { if (carry.armed && carry.expired(Date.now())) carry.drop(); }, CARRY_MS);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('focusin', onFocus, true);
      clearInterval(timer);
    };
  }, [carry]);
}
