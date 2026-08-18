// Recent-conversations dropdown for chat surfaces. Lists AgentCore Memory
// sessions (with their LLM-generated titles) from GET /api/sessions and lets
// the user jump back into one — the caller wires onPick to loadHistory().

import { useEffect, useRef, useState } from 'react';
import { useFetch } from '../hooks/useFetch';

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
  const { data } = useFetch<{ sessions: SessionSummary[] }>('/api/sessions', 30_000);
  const sessions = (data?.sessions ?? []).slice(0, 12);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  if (sessions.length === 0) return null;

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
        title="Previous conversations"
        style={{
          border: '1px solid var(--color-border)', borderRadius: 4,
          background: 'transparent', color: 'var(--color-text-secondary)',
          fontSize: 11, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit',
          whiteSpace: 'nowrap',
        }}
      >
        History ▾
      </button>
      {open && (
        <div role="listbox" style={{
          position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 130,
          width: 260, maxHeight: 320, overflowY: 'auto',
          background: 'var(--color-surface, #fff)',
          border: '1px solid var(--color-border, #e2e8f0)',
          borderRadius: 8, boxShadow: '0 4px 16px rgba(0,0,0,0.10)',
          padding: '4px 0',
        }}>
          {sessions.map(s => {
            const active = s.sessionId === activeSessionId;
            return (
              <button
                key={s.sessionId}
                role="option"
                aria-selected={active}
                onClick={() => { onPick(s.sessionId); setOpen(false); }}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1,
                  width: '100%', padding: '6px 12px', border: 'none', textAlign: 'left',
                  background: active ? 'var(--color-primary-subtle, #eef2ff)' : 'transparent',
                  color: 'var(--color-text-primary)', fontSize: 12, cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <span style={{
                  fontWeight: active ? 700 : 500, maxWidth: '100%',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                }}>
                  {s.title || 'Untitled conversation'}
                </span>
                <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>
                  {new Date(s.createdAt).toLocaleString()}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
