import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let dispose: (() => void) | undefined;
const snapshot = () => typeof window !== 'undefined'
  && document.documentElement.dataset.shellMotion !== 'off'
  && !window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const notify = () => listeners.forEach(fn => fn());
    const observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-shell-motion'] });
    media.addEventListener('change', notify);
    dispose = () => { observer.disconnect(); media.removeEventListener('change', notify); };
  }
  return () => { listeners.delete(listener); if (!listeners.size) { dispose?.(); dispose = undefined; } };
}

/** Shared preference subscription; disabled visitors never measure layout. */
export const useAmbientMotion = () => useSyncExternalStore(subscribe, snapshot, () => false);
