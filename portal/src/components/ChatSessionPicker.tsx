// Recent-conversations dropdown for chat surfaces. Lists AgentCore Memory
// sessions (with their LLM-generated titles) from GET /api/sessions and lets
// the user jump back into one — the caller wires onPick to loadHistory().

import { useEffect, useRef, useState } from 'react';
import { useFetch } from '../hooks/useFetch';
import { Button, Inline, Stack } from '@connorhoehnslalom/ui-components/shared';

interface SessionSummary {
  sessionId: string;
  actorId: string;
  createdAt: string;
  title?: string;
}

interface ChatSessionPickerProps {
  /** Currently active sessionId (highlighted in the list). */
  activeSessionId: string | null;
  onPick: (sessionId: string) => void;
}

export function ChatSessionPicker({ activeSessionId, onPick }: ChatSessionPickerProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { data, error, refresh } = useFetch<{ sessions: SessionSummary[] }>('/api/sessions', 30_000);
  const sessions = (data?.sessions ?? []).slice(0, 12);
  // /api/sessions is session-guarded — an expired cookie 401s. Hiding the
  // control in that case is the same lie as an empty list: it says "you have
  // no past conversations" when the truth is "we couldn't ask".
  const unavailable = Boolean(error) && !data;
  const needsAuth = /\b401\b|\b403\b/.test(error ?? '');

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (sessions.length === 0 && !unavailable) return null;

  return (
    <Stack gap="none" ref={rootRef} className="relative">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title={unavailable ? 'Previous conversations could not be loaded' : 'Previous conversations'}
        className="text-[11px] whitespace-nowrap"
      >
        {unavailable ? 'History ⚠' : 'History ▾'}
      </Button>
      {open && (
        <Stack
          gap="none"
          role="listbox"
          className="absolute top-[calc(100%+6px)] right-0 z-[130] w-[260px] max-h-[320px] overflow-y-auto bg-surface border border-border rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.10)] py-1"
        >
          {unavailable && (
            // Stack: three stacked lines, from a block <div>.
            <Stack gap="none" role="status" className="px-3 py-2 text-[11px] text-text-secondary">
              <Inline as="span" gap="none" className="font-semibold mb-0.5">Couldn’t load your conversations</Inline>
              <Inline as="span" gap="none" className="text-text-tertiary">
                {needsAuth
                  ? 'Your session expired — sign in to see them.'
                  : `The session list request failed (${error}).`}
              </Inline>
              <Inline gap="none" className="mt-1.5">
                <Button variant="secondary" size="sm" onClick={() => refresh()}>Retry</Button>
              </Inline>
            </Stack>
          )}
          {sessions.map(s => {
            const active = s.sessionId === activeSessionId;
            return (
              <Button
                key={s.sessionId}
                variant="ghost"
                size="sm"
                fullWidth
                role="option"
                aria-selected={active}
                onClick={() => { onPick(s.sessionId); setOpen(false); }}
                // `--color-primary-subtle` does not exist in this portal, so the
                // #eef2ff fallback always won and this row stayed indigo under a
                // non-orgiq tenant. `--color-primary-soft` is the token
                // `[data-tenant]` actually overrides — same fix graphOverlay.tsx
                // records.
                className={[
                  'flex flex-col items-start gap-px w-full px-3 py-1.5 border-none text-left',
                  'text-text-primary text-[12px] cursor-pointer',
                  active ? 'bg-[var(--color-primary-soft)]' : 'bg-transparent',
                ].join(' ')}
              >
                <Inline
                  as="span"
                  gap="none"
                  className={`max-w-full truncate ${active ? 'font-bold' : 'font-medium'}`}
                >
                  {s.title || 'Untitled conversation'}
                </Inline>
                <Inline as="span" gap="none" className="text-[10px] text-text-tertiary">
                  {new Date(s.createdAt).toLocaleString()}
                </Inline>
              </Button>
            );
          })}
        </Stack>
      )}
    </Stack>
  );
}
