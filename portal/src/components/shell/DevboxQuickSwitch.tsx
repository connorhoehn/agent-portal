// ⌘I — devbox quick-switch, registered into the shared CommandPalette (⌘K)
// under a "Devbox" group. Lists the named devboxes (each its own AgentCore
// runtime session = its own microVM + persistent workspace), jumps to one,
// or provisions a new one.
//
// This used to be a hand-rolled overlay (window keydown capture, div rows
// with no option semantics, a Card with no dialog role). The palette now
// owns rows, fuzzy filtering, arrow-key/Tab focus movement and dismissal —
// this file only contributes commands via useRegisterCommand.
//
// CommandPaletteProvider hardcodes exactly one dialog-opening hotkey (⌘K);
// a command's own `hotkey` fires that command's `run()` directly but there
// is no public `open(query)` / `setQuery` an outside caller can use to
// pre-fill the search box in a second dialog. So ⌘I is wired as a command
// hotkey whose run() asks Layout (via `onScopeChange`) to hide every other
// registered command for as long as the palette stays open, then opens the
// same ⌘K dialog — from the keyboard the effect is a palette that opens
// showing only the Devbox group, which is the closest a single-palette API
// gets to "open pre-filtered to a group".
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useCompute, type Computer } from '@connorhoehnslalom/ui-components/compute';
import {
  useCommandPalette, useRegisterCommand, type Command,
} from '@connorhoehnslalom/ui-components/shared';

export type PaletteScope = 'all' | 'devbox';

interface DevboxQuickSwitchProps {
  /** Lets this component narrow the palette to the Devbox group on ⌘I,
      and hand it back once the dialog closes. Owned by Layout, which also
      applies it to the rest of the command list. */
  onScopeChange: (scope: PaletteScope) => void;
}

export function DevboxQuickSwitch({ onScopeChange }: DevboxQuickSwitchProps) {
  const navigate = useNavigate();
  // The fleet, and whether this session may add to it, both come from the
  // app-wide ComputeHost — one list, one answer, no localStorage mirror to
  // drift out of step with the dock.
  const { computers: boxes, create, canManage, isLoading, error } = useCompute();
  const { open, isOpen } = useCommandPalette();
  const [busy, setBusy] = useState(false);

  const go = useCallback((box: Computer) => {
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
  }, [busy, create, boxes.length, go]);

  // The devbox scope is only for the dialog it opened into — drop it the
  // moment the palette closes, however that happened (Escape, outside
  // click, a selection), so a later ⌘K isn't silently still narrowed.
  useEffect(() => {
    if (!isOpen) onScopeChange('all');
  }, [isOpen, onScopeChange]);

  useRegisterCommand(useMemo<Command>(() => ({
    id: 'devbox:quick-switch',
    label: 'Computers — quick switch',
    hint: 'Jump to a computer, or create one',
    group: 'Devbox',
    shortcut: ['⌘I'],
    hotkey: 'mod+i',
    keywords: ['devbox', 'computer', 'microvm', 'quick switch'],
    run: () => { onScopeChange('devbox'); open(); },
  }), [onScopeChange, open]));

  useRegisterCommand(useMemo<Command>(() => ({
    id: 'devbox:new',
    label: busy ? '⏳ provisioning…' : '+ New computer',
    hint: 'fresh microVM workspace',
    group: 'Devbox',
    when: () => canManage,
    run: () => { void provision(); },
  }), [busy, canManage, provision]));

  // Every state the old overlay explained in prose now explains itself as
  // one command row instead of leaving ⌘I-while-devbox-scoped open onto an
  // unhelpful "No results."
  useRegisterCommand(useMemo<Command>(() => ({
    id: 'devbox:no-access',
    label: 'You don’t have access to computers',
    hint: 'Ask an SME or HR admin to grant you computer access',
    group: 'Devbox',
    when: () => !canManage,
    run: () => {},
  }), [canManage]));

  useRegisterCommand(useMemo<Command>(() => ({
    id: 'devbox:error',
    label: error ? `Couldn’t load computers: ${error}` : 'Couldn’t load computers',
    hint: 'try again shortly',
    group: 'Devbox',
    when: () => canManage && !!error,
    run: () => {},
  }), [canManage, error]));

  useRegisterCommand(useMemo<Command>(() => ({
    id: 'devbox:empty',
    label: 'No computers yet — open Computer Lab',
    hint: 'or use + New computer above',
    group: 'Devbox',
    when: () => canManage && !error && !isLoading && boxes.length === 0,
    run: () => navigate('/admin/devbox'),
  }), [canManage, error, isLoading, boxes.length, navigate]));

  return (
    <>
      {boxes.map((box) => (
        <DevboxBoxCommand key={box.id} box={box} onGo={go} />
      ))}
    </>
  );
}

// One command per box. A variable-length list can't come from a single
// useRegisterCommand call (hook count must stay fixed), so each box gets its
// own instance of this headless component instead — React's keyed
// reconciliation registers/unregisters as the fleet changes.
function DevboxBoxCommand({ box, onGo }: { box: Computer; onGo: (box: Computer) => void }) {
  useRegisterCommand(useMemo<Command>(() => ({
    id: `devbox:go:${box.id}`,
    label: box.label,
    // The state and the creation date tell two boxes apart; a session-id tail is an opaque digit run the reader cannot use.
    hint: `${box.status ?? 'computer'} · created ${new Date(box.createdAt).toLocaleDateString()}`,
    group: 'Devbox',
    keywords: [box.sessionId, box.label],
    run: () => onGo(box),
  }), [box, onGo]));
  return null;
}
