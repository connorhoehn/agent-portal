// LocalComputeBadge — "my machine is in the fleet", in the header.
//
// Thin host wiring over the library's MachinePresenceMenu: poll the
// local-compute presence API for the caller's own machines, map the wire
// shape onto MachineNode, and hand the lab deep-link in. All rendering
// decisions (render null with no machines, pulse only while working, the
// memory-sync line) live in the library component.
//
// Polling, not SSE, on purpose: the badge is glanceable status, the 15s
// cadence matches the work summary next to it, and the presence stream stays
// available for a surface that needs immediacy (the lab itself).

import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import {
  MachinePresenceMenu,
  type MachineNode,
  type MachineSession,
} from '@connorhoehnslalom/ui-components/compute';
import { useFetch } from '../../hooks/useFetch';

interface WireSession {
  sessionId: string;
  harness?: string;
  projectId?: string;
  repo?: string;
  branch?: string;
  worktree?: string;
  intent?: string;
  modelProvider?: string;
  model?: string;
  contextUsed?: number;
  memory?: MachineSession['memory'];
  startedAt?: number;
}

interface WireNode {
  id: string;
  label: string;
  platform: string | null;
  presence: {
    status: MachineNode['status'];
    sessions: WireSession[];
  };
}

const POLL_MS = 15_000;

function toMachineNode(node: WireNode): MachineNode {
  return {
    id: node.id,
    label: node.label,
    status: node.presence.status,
    ...(node.platform ? { platform: node.platform } : {}),
    sessions: node.presence.sessions.map((s): MachineSession => ({
      id: s.sessionId,
      harness: s.harness,
      projectId: s.projectId,
      repo: s.repo,
      branch: s.branch,
      worktree: s.worktree,
      intent: s.intent,
      modelProvider: s.modelProvider,
      model: s.model,
      contextUsed: s.contextUsed,
      memory: s.memory,
      startedAt: s.startedAt,
    })),
  };
}

export function LocalComputeBadge() {
  const navigate = useNavigate();
  // 401/403 (signed out, or a role without the read floor) surfaces as
  // `error` and renders nothing — the header never nags about a feature the
  // session can't reach.
  const { data } = useFetch<{ nodes: WireNode[] }>('/api/local-compute/nodes', POLL_MS);
  const nodes = useMemo(() => (data?.nodes ?? []).map(toMachineNode), [data]);

  return (
    <MachinePresenceMenu
      nodes={nodes}
      onOpenLab={() => navigate('/iq/local-compute')}
      data-testid="local-compute-badge"
    />
  );
}
