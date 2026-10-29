// The Computer Lab's default pane, taught to tell a laptop from a microVM.
//
// Split from localMachines.ts purely so the mapping there stays loadable by
// `node --test`, which strips types but cannot transform JSX. Everything that
// renders lives here; everything that decides lives there.

import { DEFAULT_PANE_KINDS, TAIL_PANE_KIND } from '@connorhoehnslalom/ui-components/compute';
import type { PaneKind } from '@connorhoehnslalom/ui-components/compute';
import { InlineAlert, Stack } from '@connorhoehnslalom/ui-components/shared';
import { NodeLog } from '../../pages/local-compute/NodeLog';
import { isLocalMachineId, nodeIdOf } from './localMachines';

/**
 * The lab's default pane, taught to tell a laptop from a microVM.
 *
 * `PaneKind` carries no applicability rule and the registry's FIRST entry is
 * what every new pane gets, so "shell for a box, log for a machine" cannot be
 * expressed as two kinds. Focusing a paired machine therefore opened a
 * terminal and sat there showing `error · Forbidden` and `pty` — a shell for a
 * computer that has no shell, which is exactly the "never offer an affordance
 * the machine can't back" rule in docs/local-compute-presence.md.
 *
 * The host cannot correct it from outside either: `useLabLayout()` hands back
 * its own layout instance rather than the lab's (measured — it reports zero
 * panes while the lab shows one), so there is no `setPaneKind` to reach for.
 *
 * What IS available is the default kind itself. This wraps it: same id, same
 * label, same quota and input handling, and a `render` that delegates to the
 * original for a microVM and shows the machine's log for a laptop. A box
 * behaves exactly as before — it is the same kind object with one branch in
 * front of its renderer.
 *
 * When `Computer.kind?: 'microvm' | 'local'` ships the registry can pick this
 * itself and the wrapper goes. Queued in docs/ui-components-queue.md, in the
 * same row as the pane CHROME half of the gap — the frame still says `shell`
 * and `pty` around this log, which no consumer can reach.
 */
const [defaultKind, ...otherKinds] = DEFAULT_PANE_KINDS;

/**
 * The pane a microVM gets when this session may not open a shell on it.
 *
 * The fleet has a READ tier (org-leader, program-owner — `FLEET_READ_ROLES`)
 * without `ManageDevbox`, and the lab's default pane is a terminal that
 * attaches on mount: for those roles every page load POSTed `shell-url`, got a
 * 403, logged it as a console error and painted `error · Forbidden` with a
 * "reattach" that could never succeed. The capability already said no, so the
 * pane does not ask. It says why instead, and shows the computer's tail —
 * read-only, no shell slot, and served to anyone who can see the box — so the
 * pane still answers "what is it doing". Since DE-42 `shell-url` asks
 * OpenDevboxShell (devbox.ts:860) on top of the mount's ManageDevbox, so
 * `canOpenShell` below is both (ComputeHost.tsx).
 */
function shellUnavailable(ctx: Parameters<PaneKind['render']>[0]) {
  return (
    <Stack gap="none" className="h-full min-h-0">
      <InlineAlert tone="info" palette="code" className="m-2 flex-none" data-testid="shell-unavailable">
        No shell for your role — opening one needs the OpenDevboxShell capability, which SMEs hold on their
        initiatives&apos; computers and HR admins hold fleet-wide. Showing this computer&apos;s activity instead.
      </InlineAlert>
      <Stack gap="none" className="min-h-0 flex-1">{TAIL_PANE_KIND.render(ctx)}</Stack>
    </Stack>
  );
}

/** The lab's pane kinds for a session that may (`canOpenShell`) or may not
 *  attach a shell. Memoize the result: the lab reads the registry by identity. */
export function labPaneKinds(canOpenShell: boolean): PaneKind[] {
  if (!defaultKind) return [...DEFAULT_PANE_KINDS];
  return [
    {
      ...defaultKind,
      render: (ctx) => (
        isLocalMachineId(ctx.computer.id)
          ? <NodeLog nodeId={nodeIdOf(ctx.computer.id)} />
          : canOpenShell ? defaultKind.render(ctx) : shellUnavailable(ctx)
      ),
    },
    ...otherKinds,
  ];
}
