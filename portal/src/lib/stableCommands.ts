// A composer's `/` commands with an identity that changes only when what they
// say changes (regression walk, 9 November night: fast typing threw React's
// "Maximum update depth exceeded" from RichChatComposer's onUpdate).
//
// THE CAUSE. The library's RichChatComposer re-derives its command bar in a
// passive effect keyed on the `commands` ARRAY (ui-components origin/main
// src/components/social/RichChatComposer.tsx:1323-1330). Hosts that write
// state on every keystroke (Search's controlled draft and input, an
// initiative's draft text) built that array inline, or memoized it on inputs
// that are new arrays every render, so every keystroke's sync commit ran the
// effect and queued a Default-priority update. Keys arriving faster than that
// Default render keep it pending, and React counts each following sync commit
// as a nested update until it throws at 50.
//
// FIXED IN THE LIBRARY. ui-components 2.515.11 keys that effect on a content
// signature of the commands instead of the array, so the cause is gone there.
// This helper stays: it is harmless and still guards older library versions.
//
// THE FIX HERE. The array keeps its identity while the commands' visible
// content (trigger, label, hint, description, disabled, modes, argument
// placeholder) is the same; `run`, `argument.search` and `argument.onPick`
// are forwarded to the latest render's functions, so nothing goes stale.

import { useMemo, useRef } from 'react';

interface CommandLike {
  trigger: string;
  label: string;
  hint?: string;
  description?: string;
  disabled?: boolean;
  modes?: readonly string[];
  argument?: { placeholder?: string; search: (query: string) => unknown; onPick?: (item: never) => unknown };
  run?: (input: never) => unknown;
}

/** What a command shows and accepts, as one string: a change here is a change the composer must see. */
export function commandsSignature(commands: readonly CommandLike[] | undefined): string {
  if (!commands) return '';
  return JSON.stringify(commands.map((c) => [
    c.trigger, c.label, c.hint ?? null, c.description ?? null, !!c.disabled,
    c.modes ? [...c.modes] : null, c.argument ? (c.argument.placeholder ?? '') : null, !!c.argument?.onPick,
  ]));
}

/**
 * The commands with their functions routed through `latest()`, so an array
 * built once still calls this render's closures. Pure, for the node tests.
 */
export function forwardToLatest<C extends CommandLike>(commands: readonly C[], latest: () => readonly C[] | undefined): C[] {
  const current = (trigger: string) => latest()?.find((c) => c.trigger === trigger);
  return commands.map((c) => ({
    ...c,
    ...(c.run ? { run: ((input: never) => (current(c.trigger)?.run ?? c.run)!(input)) as C['run'] } : {}),
    ...(c.argument ? {
      argument: {
        ...c.argument,
        search: (query: string) => (current(c.trigger)?.argument?.search ?? c.argument!.search)(query),
        ...(c.argument.onPick ? { onPick: (item: never) => (current(c.trigger)?.argument?.onPick ?? c.argument!.onPick)!(item) } : {}),
      },
    } : {}),
  }));
}

/** `commands`, with an identity that only changes when `commandsSignature` does. */
export function useStableCommands<C extends CommandLike>(commands: readonly C[]): C[];
export function useStableCommands<C extends CommandLike>(commands: readonly C[] | undefined): C[] | undefined;
export function useStableCommands<C extends CommandLike>(commands: readonly C[] | undefined): C[] | undefined {
  const latest = useRef(commands);
  latest.current = commands;
  const signature = commandsSignature(commands);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => (latest.current ? forwardToLatest(latest.current, () => latest.current) : undefined), [signature]);
}
