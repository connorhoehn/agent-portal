// Global toast stack — top-right, slide-in, live-updating cards.
// Mounted once in Layout; pages drive it via lib/toastStore.

import { useSyncExternalStore } from 'react';
import {
  Chip, CloseIcon, EntityCell, IconButton, Inline, MetaLine, Spinner, Stack,
} from '@connorhoehn/ui-components/shared';
import {
  subscribeToasts,
  getToasts,
  dismissToast,
  type Toast,
} from '../../lib/toastStore';

function iconFor(t: Toast) {
  if (t.kind === 'pending') return <Spinner size="sm" />;
  if (t.kind === 'success') return <Chip size="xs" tone="success" className="shrink-0">✓</Chip>;
  if (t.kind === 'error') return <Chip size="xs" tone="danger" className="shrink-0">✗</Chip>;
  return <Chip size="xs" tone="info" className="shrink-0">ℹ</Chip>;
}

export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  if (toasts.length === 0) return null;

  return (
    <Stack gap="sm" className="fixed top-14 right-4 z-[200] w-[320px] pointer-events-none">
      {toasts.map((t) => (
        <Inline
          key={t.id}
          gap="sm"
          align="start"
          role="status"
          // The entrance keyframes live in app.css; this is the arbitrary-value
          // class that plays them, so no JSX `style=` prop is needed.
          className={`pointer-events-auto px-3.5 py-2.5 rounded-lg border shadow-lg bg-surface min-w-0 [animation:toast-in_0.18s_ease-out] ${
            t.kind === 'error' ? 'border-danger/40' : t.kind === 'success' ? 'border-success/40' : 'border-border'
          }`}
        >
          <Stack gap="none" className="mt-0.5">{iconFor(t)}</Stack>
          <Stack gap="none" className="flex-1 min-w-0">
            <EntityCell label={t.title} className="min-w-0" />
            {t.detail && (
              <MetaLine size="xs" className="leading-snug mt-0.5 break-words" items={[t.detail]} />
            )}
          </Stack>
          <IconButton
            aria-label="Dismiss"
            icon={<CloseIcon />}
            size="sm"
            className="shrink-0"
            onClick={() => dismissToast(t.id)}
          />
        </Inline>
      ))}
    </Stack>
  );
}
