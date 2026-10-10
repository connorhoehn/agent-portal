// Local machines, folded into the Computer Lab's own fleet.
//
// WHY THIS EXISTS. A paired laptop used to render as a separate band ABOVE
// `<ComputerLab>` while the lab itself reported "0 computers · nothing here"
// and told you to provision one. Two machines on screen, and the surface whose
// job is to show your machines said it had none — and the band squeezed the
// lab's rail badly enough that its section headings overlapped. The machine
// belongs IN the lab, not stacked on top of it.
//
// THE SEAM. `ComputerLabProps` takes no fleet, so there is nothing to pass it
// directly — but `ComputeProvider` does, and the lab reads the fleet from that
// context. `client` ("bring your own transport") lets us wrap the reference
// client and return the microVM boxes PLUS the local machines from one
// `listComputers()`, so the lab, the dock, the ⌘K palette and the ⌘I switcher
// all see one list. That is the property ComputeHost's own header insists on:
// "two components disagreeing about whether a computer exists is the class of
// bug the old localStorage mirror produced."
//
// A machine carries `kind: 'local'` (ui-components 2.411): the lab draws it
// with a laptop glyph and the pane registry keeps a terminal off it. The
// `local:` id prefix stays because `nodeIdOf` reads the node id back out of it
// for the machine's log pane.

import type { ComputeClient, Computer } from '@connorhoehnslalom/ui-components/compute';

/** Marks a `Computer` id as a paired machine rather than a microVM box. */
export const LOCAL_ID_PREFIX = 'local:';

export function isLocalMachineId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

/** The node id behind a local machine's `Computer` id. */
export function nodeIdOf(computerId: string): string {
  return computerId.slice(LOCAL_ID_PREFIX.length);
}

/** The wire shape of `GET /api/local-compute/nodes`, narrowed to what maps. */
interface NodeWire {
  id: string;
  label: string;
  acceptJobs?: boolean;
  presence: { status: 'connected' | 'stale' | 'offline'; lastSeenAt?: string | null };
  platform?: string | null;
  registeredAt?: string | null;
}

/**
 * A paired machine as the lab's `Computer`.
 *
 * `sessionId` is documented as "AgentCore runtimeSessionId, ≥33 chars — the
 * real address". A laptop has no such session, and inventing one that LOOKS
 * like an AgentCore id would be a lie the shell pane would then try to dial.
 * It is filled with a self-describing, deterministic string that is obviously
 * not a runtime session, long enough to satisfy the length rule, and stable so
 * a saved layout reattaches to the same pane.
 */
export function machineToComputer(n: NodeWire): Computer {
  const status = n.presence.status === 'connected'
    ? (n.acceptJobs ? 'idle' : 'waiting')
    : 'stopped';
  return {
    id: `${LOCAL_ID_PREFIX}${n.id}`,
    // What the lab reads to draw a laptop and to keep a terminal off it.
    kind: 'local',
    label: n.label,
    sessionId: `local-machine-no-agentcore-session-${n.id}`,
    createdAt: n.registeredAt ?? new Date().toISOString(),
    status,
    ...(n.presence.lastSeenAt ? { lastActivityAt: n.presence.lastSeenAt } : {}),
    // Said out loud in the row rather than left to be inferred from a green
    // dot: "connected" and "taking work" are different facts, and the pause is
    // the single most common reason a machine looks alive and does nothing.
    currentTask: n.presence.status !== 'connected'
      ? 'Not reachable — the worker is not running'
      : (n.acceptJobs ? 'Waiting for work' : 'Paused — "Accepting work" is off'),
    ...(n.platform ? { workspace: n.platform } : {}),
  };
}

/**
 * The reference client, plus the caller's own machines.
 *
 * Failing to read the machines must never take the microVM fleet down with it:
 * the lab's whole fleet disappearing because a laptop endpoint 500'd would be
 * a far worse outcome than the laptop simply not appearing.
 */
export function withLocalMachines(base: ComputeClient): ComputeClient {
  return {
    ...base,
    async listComputers(signal?: AbortSignal): Promise<Computer[]> {
      const boxes = await base.listComputers(signal);
      try {
        const res = await fetch('/api/local-compute/nodes', {
          credentials: 'same-origin',
          ...(signal ? { signal } : {}),
        });
        if (!res.ok) return boxes;
        const body = (await res.json()) as { nodes?: NodeWire[] };
        return [...boxes, ...(body.nodes ?? []).map(machineToComputer)];
      } catch {
        return boxes;
      }
    },
  };
}
