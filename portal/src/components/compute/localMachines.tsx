// The Computer Lab's default pane, taught to tell a laptop from a microVM.
//
// Split from localMachines.ts purely so the mapping there stays loadable by
// `node --test`, which strips types but cannot transform JSX. Everything that
// renders lives here; everything that decides lives there.

import { DEFAULT_PANE_KINDS } from '@connorhoehnslalom/ui-components/compute';
import type { PaneKind } from '@connorhoehnslalom/ui-components/compute';
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
 * When `Computer.kind?: 'microvm' | 'local'` ships (queued in
 * docs/ui-components-queue.md) the registry can pick this itself and the
 * wrapper goes.
 */
const [defaultKind, ...otherKinds] = DEFAULT_PANE_KINDS;

export const labPaneKinds: PaneKind[] = defaultKind
  ? [
    {
      ...defaultKind,
      render: (ctx) => (
        isLocalMachineId(ctx.computer.id)
          ? <NodeLog nodeId={nodeIdOf(ctx.computer.id)} />
          : defaultKind.render(ctx)
      ),
    },
    ...otherKinds,
  ]
  : [...DEFAULT_PANE_KINDS];
