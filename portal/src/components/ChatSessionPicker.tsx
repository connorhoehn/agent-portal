// Recent-conversations dropdown for chat surfaces. Lists AgentCore Memory
// sessions (with their LLM-generated titles) from GET /api/sessions and lets
// the user jump back into one — the caller wires onPick to loadHistory().

import { useEffect, useRef, useState } from 'react';
import { useFetch } from '../hooks/useFetch';
import { Button, ChoiceList, ChoiceRow, Inline, Stack } from '@connorhoehn/ui-components/shared';

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
        aria-haspopup="true"
        title={unavailable ? 'Previous conversations could not be loaded' : 'Previous conversations'}
        className="text-xs whitespace-nowrap"
      >
        {unavailable ? 'History ⚠' : 'History ▾'}
      </Button>
      {open && (
        <Stack
          gap="none"
          className="absolute top-[calc(100%+6px)] right-0 z-[130] w-[260px] max-h-[320px] overflow-y-auto bg-surface border border-border rounded-lg shadow-[0_4px_16px_rgba(0,0,0,0.10)] py-1"
        >
          {unavailable && (
            // Stack: three stacked lines, from a block <div>.
            <Stack gap="none" role="status" className="px-3 py-2 text-xs text-text-secondary">
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
          {sessions.length > 0 && (
            // ChoiceRow: title + one-line timestamp. These were two-line
            // labels in a ghost `Button`, which the one-box-per-size button
            // (2.407.14) clips.
            <ChoiceList data-testid="chat-session-list">
              {sessions.map(s => (
                <ChoiceRow
                  key={s.sessionId}
                  title={s.title || 'Untitled conversation'}
                  description={new Date(s.createdAt).toLocaleString()}
                  selected={s.sessionId === activeSessionId}
                  onSelect={() => { onPick(s.sessionId); setOpen(false); }}
                  data-testid={`chat-session-${s.sessionId}`}
                />
              ))}
            </ChoiceList>
          )}
        </Stack>
      )}
    </Stack>
  );
}
