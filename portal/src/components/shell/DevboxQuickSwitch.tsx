// ⌘I — devbox quick-switch overlay, the devbox sibling of the ⌘K palette.
// Lists the named devboxes (each its own AgentCore runtime session = its own
// microVM + persistent workspace), jumps to one, or provisions a new one.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCompute, type Computer } from '@connorhoehnslalom/ui-components/compute';
import {
  Card, EntityCell, Inline, InlineAlert, MetaLine, SectionLabel, Stack,
} from '@connorhoehnslalom/ui-components/shared';

const mono = 'font-["Fira_Code","Cascadia_Code","JetBrains_Mono",monospace]';

export function DevboxQuickSwitch() {
  const navigate = useNavigate();
  // The fleet, and whether this session may add to it, both come from the
  // app-wide ComputeHost — one list, one answer, no localStorage mirror to
  // drift out of step with the dock.
  const { computers: boxes, create, canManage, isLoading, error } = useCompute();
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const overlayRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return boxes;
    return boxes.filter((b) =>
      b.label.toLowerCase().includes(q) || b.sessionId.toLowerCase().includes(q));
  }, [boxes, query]);

  // Rows: matching boxes + the "new devbox" action (ManageDevbox only).
  const rows = useMemo(() => matches.length + (canManage ? 1 : 0), [matches, canManage]);

  const go = useCallback((box: Computer) => {
    setOpen(false);
    navigate(`/admin/devbox?box=${box.id}`);
  }, [navigate]);

  const provision = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const box = await create({ label: `computer-${boxes.length + 1}` });
      go(box);
    } finally {
      setBusy(false);
    }
  }, [busy, go, create, boxes.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'i' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        setHighlight(0);
        setQuery('');
        setOpen((v) => !v);
        return;
      }
      if (!open) return;

      if (e.key === 'Escape') { setOpen(false); }
      else if (e.key === 'ArrowDown') { setHighlight((h) => (h + 1) % rows); }
      else if (e.key === 'ArrowUp') { setHighlight((h) => (h - 1 + rows) % rows); }
      else if (e.key === 'Tab') {
        // Tab and shift-Tab walk the list, because that is what people press
        // when a thing looks like a switcher.
        setHighlight((h) => (h + (e.shiftKey ? -1 : 1) + rows) % rows);
      }
      else if (e.key === 'Enter') {
        if (highlight < matches.length) { const b = matches[highlight]; if (b) go(b); }
        else if (canManage) void provision();
      }
      else if (e.key === 'Backspace') { setQuery((q) => q.slice(0, -1)); setHighlight(0); }
      else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        setQuery((q) => q + e.key);
        setHighlight(0);
      }

      // Nothing escapes while the overlay is up.
      //
      // This used to listen in bubble phase and only preventDefault the four
      // keys it handled. xterm's own handler sits on its textarea and runs
      // first, so every other keystroke was typed into the terminal underneath
      // — the overlay looked focused and wasn't, and there was no way to
      // filter or even type without corrupting whatever shell was behind it.
      e.preventDefault();
      e.stopPropagation();
    };
    // Capture phase: xterm must not see these at all.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, rows, highlight, matches, go, provision, canManage]);

  // Take DOM focus off the terminal while the overlay is up, so the browser
  // agrees with what the screen shows.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    overlayRef.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  return (
    <Inline
      gap="none"
      align="start"
      justify="center"
      wrap={false}
      className="fixed inset-0 z-[200] bg-black/40 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      {/* Card takes a ref as of 2.233.0, which is what lets the panel keep
          taking DOM focus off the terminal underneath. */}
      <Card
        ref={overlayRef}
        tabIndex={-1}
        className="w-[440px] max-w-[90vw] shadow-xl outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <Inline gap="sm" wrap={false} className="px-4 py-2.5 border-b border-border">
          <SectionLabel>Computers</SectionLabel>
          <MetaLine size="xs" items={['⌘I · ↑↓ / tab · ⏎ · esc']} />
          <Inline as="span" gap="none" className="flex-1" />
          {query
            ? <Inline as="span" gap="none" className={`text-[11px] text-text-primary ${mono}`}>{query}</Inline>
            : <MetaLine size="xs" items={['type to filter']} />}
        </Inline>
        <Stack gap="none" className="max-h-[50vh] overflow-y-auto">
          {/* The switcher used to open onto nothing for a role without
              Computer Lab, or while the fleet was still loading, or when the
              fleet was empty — a blank popover that says "type to filter".
              Every one of those states now says what is true and what to do. */}
          {!canManage && (
            <Stack gap="none" className="px-4 py-3 text-[12px] text-text-secondary">
              <Inline as="span" gap="none" className="font-semibold text-text-primary">
                You don’t have access to computers.
              </Inline>{' '}
              Computer Lab needs the <Inline as="span" gap="none" className={mono}>ManageDevbox</Inline> capability
              (SME or HR admin). Ask an administrator, or sign in as a role that has it.
            </Stack>
          )}
          {canManage && error && (
            <Stack gap="none" className="px-4 py-3">
              <InlineAlert tone="error">Couldn’t load computers: {error}</InlineAlert>
            </Stack>
          )}
          {canManage && !error && isLoading && boxes.length === 0 && (
            <MetaLine className="px-4 py-3" items={['Loading computers…']} />
          )}
          {canManage && !error && !isLoading && boxes.length === 0 && (
            <MetaLine tone="secondary" className="px-4 py-3"
              items={['No computers yet — create one below, or open Computer Lab.']} />
          )}
          {canManage && !error && boxes.length > 0 && matches.length === 0 && (
            <MetaLine className="px-4 py-3" items={[`No computer matches “${query}”.`]} />
          )}
          {matches.map((box, i) => (
            <Inline
              key={box.id}
              gap="sm"
              wrap={false}
              onClick={() => go(box)}
              onMouseEnter={() => setHighlight(i)}
              className={`px-4 py-2.5 cursor-pointer border-b border-border ${highlight === i ? 'bg-surface-hover' : ''}`}
            >
              <EntityCell label={box.label} labelClassName="text-[13px] font-semibold" />
              <Inline as="span" gap="none" className={`text-[11px] text-text-tertiary ${mono}`}>
                …{box.sessionId.slice(-10)}
              </Inline>
              <Inline as="span" gap="none" className="flex-1" />
              <MetaLine size="xs" items={[new Date(box.createdAt).toLocaleDateString()]} />
            </Inline>
          ))}
          {canManage && (
            <Inline
              gap="sm"
              wrap={false}
              onClick={() => void provision()}
              onMouseEnter={() => setHighlight(matches.length)}
              className={`px-4 py-2.5 cursor-pointer ${highlight === matches.length ? 'bg-surface-hover' : ''}`}
            >
              <Inline as="span" gap="none" className="text-[13px] font-semibold text-primary">
                {busy ? '⏳ provisioning…' : '+ New computer'}
              </Inline>
              <MetaLine size="xs" items={['fresh microVM workspace']} />
            </Inline>
          )}
        </Stack>
      </Card>
    </Inline>
  );
}
