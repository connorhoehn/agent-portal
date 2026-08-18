// Global toast stack — top-right, slide-in, live-updating cards.
// Mounted once in Layout; pages drive it via lib/toastStore.

import { useSyncExternalStore } from 'react';
import {
  subscribeToasts,
  getToasts,
  dismissToast,
  type Toast,
} from '../../lib/toastStore';

function Spinner() {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent shrink-0"
      style={{ animation: 'toast-spin 0.8s linear infinite' }}
    />
  );
}

function iconFor(t: Toast) {
  if (t.kind === 'pending') return <Spinner />;
  if (t.kind === 'success') return <span className="text-success font-bold text-[13px] shrink-0">✓</span>;
  if (t.kind === 'error') return <span className="text-danger font-bold text-[13px] shrink-0">✗</span>;
  return <span className="text-primary font-bold text-[13px] shrink-0">ℹ</span>;
}

export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 right-4 z-[200] flex flex-col gap-2 w-[320px] pointer-events-none">
      <style>{`
        @keyframes toast-spin { to { transform: rotate(360deg); } }
        @keyframes toast-in { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
      `}</style>
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={`pointer-events-auto flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg border shadow-lg bg-surface min-w-0 ${
            t.kind === 'error' ? 'border-danger/40' : t.kind === 'success' ? 'border-success/40' : 'border-border'
          }`}
          style={{ animation: 'toast-in 0.18s ease-out' }}
        >
          <span className="mt-0.5">{iconFor(t)}</span>
          <div className="flex-1 min-w-0">
            <div className="text-[12.5px] font-semibold text-text-primary leading-snug">{t.title}</div>
            {t.detail && (
              <div className="text-[11px] text-text-tertiary leading-snug mt-0.5 break-words">{t.detail}</div>
            )}
          </div>
          <button
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
            className="border-none bg-transparent cursor-pointer text-text-tertiary hover:text-text-primary text-[13px] leading-none p-0.5 shrink-0"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
