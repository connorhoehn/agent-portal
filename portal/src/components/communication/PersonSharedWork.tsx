// "The work they have shared" (docs/communication-plane-goal.md §3): one
// person's work graph as THIS viewer may see it —
// GET /api/social/plane/people/:userId/shared-work, the person's work-graph
// subject filtered on the server against the sharing grants the viewer is an
// audience of (and the work referenced in conversations the viewer is in).
// The owner sees all of their own, with the share affordance on each node
// and their grants listed with Stop. A viewer with no grant and no shared
// conversation gets an empty graph, not a refusal — the canvas says so.
//
// Drawn with the library `WorkGraph` (through WorkGraphActivity, the same
// realtime-modules `useWorkGraph` handshake every other work graph uses).
// Opening a node hands it to the host, which shows it in the far-right pane.

import { useState } from 'react';
import { ActionRowList } from '@connorhoehnslalom/ui-components';
import { Button, ChannelHeader, MetaLine, SectionLabel, Stack } from '@connorhoehnslalom/ui-components/shared';
import { WorkGraphActivity } from '../work-graph/WorkGraphActivity';
import { readSharing, type SharingEnvelope } from './planeSharingModel';
import { SharingGrants } from './WorkSharing';

export interface PersonSharedWorkProps {
  userId: string;
  name: string;
  self: boolean;
  online?: boolean;
  onMessage?: () => void;
  onOpenNode?: (node: { id: string; title: string; kind: string }, href: string | null) => void;
  /** The owner's share affordance on a node of their own graph (the node's row, or the inspector's request). */
  onShareNode?: (node: { id: string; title: string; kind: string; href: string | null }, refresh: () => void) => void;
}

type GraphNode = { id: string; title: string; kind: string; href: string | null };
const PROVENANCE: Record<string, string> = { active: 'shared now', historical: 'shared earlier', referenced: 'referenced in a conversation' };

export function PersonSharedWork({ userId, name, self, online, onMessage, onOpenNode, onShareNode }: PersonSharedWorkProps) {
  const [sharing, setSharing] = useState<SharingEnvelope | null>(null);
  const [generation, setGeneration] = useState(0);
  const [nodes, setNodes] = useState<readonly GraphNode[]>([]);
  const refresh = () => setGeneration((n) => n + 1);
  const counts = sharing ? Object.values(sharing.provenance).reduce((acc, p) => ({ ...acc, [p]: (acc[p] ?? 0) + 1 }), {} as Record<string, number>) : {};
  return (
    <Stack gap="md" className="min-h-0 min-w-0 flex-1 overflow-auto" data-testid="plane-person-shared-work" data-user={userId}
      data-viewer={sharing?.viewer ?? 'unknown'}>
      <ChannelHeader name={self ? 'Your work' : `${name}’s shared work`} {...(online !== undefined ? { online } : {})}
        description={self ? 'Everything of yours on the work graph. Open a node and share it with a conversation.'
          : `What ${name} has shared with you, and the work referenced in conversations you are both in.`}
        {...(!self && onMessage ? { actions: <Button variant="secondary" size="sm" onClick={onMessage} data-testid="plane-person-message">Message</Button> } : {})} />
      {!self && sharing && (
        <MetaLine size="sm" tone="secondary" data-testid="plane-person-sharing-summary"
          items={sharing.viewer === 'none' ? ['Nothing shared with you'] : [
            counts['active'] ? `${counts['active']} shared now` : null,
            counts['historical'] ? `${counts['historical']} shared earlier` : null,
            counts['referenced'] ? `${counts['referenced']} referenced in your conversations` : null,
          ]} />
      )}
      {/* A floor, never a fixed height, and no shrinking: the library's activity layout fills the floor, while its
          plain canvas (a share with no effort anchor) sizes itself (`clamp(22rem,55vh,42rem)`). This Stack is a
          flex column, so without `shrink-0` the graph is squeezed below its content and the canvas paints over the
          list — the rows were unclickable under the react-flow pane at 940px (D2). */}
      <WorkGraphActivity key={`${userId}:${generation}`} subject={{ kind: 'shared-work', id: userId }} mode="split"
        title={self ? 'Your work today' : `${name} · shared with you`}
        className="min-h-[420px] shrink-0"
        emptyMessage={self ? 'Nothing of yours is on the work graph today.' : `${name} has not shared any work with you yet.`}
        onEnvelope={(body) => setSharing(readSharing(body && typeof body === 'object' ? (body as { sharing?: unknown }).sharing : null))}
        onNodes={setNodes}
        {...(onOpenNode ? { onOpenNode } : {})}
        {...(self && onShareNode ? {
          onRequestCollaboration: (selection) => {
            const node = selection.kind === 'node' ? nodes.find((n) => n.id === selection.id) : undefined;
            if (node) onShareNode(node, refresh);
          },
        } : {})} />
      {nodes.length > 0 && (
        <Stack gap="sm">
          <SectionLabel as="h2">{self ? 'Your items' : 'Shared items'}</SectionLabel>
          {/* The canvas's nodes as a list: each opens in the far-right pane (yours with Share). */}
          <ActionRowList size="sm" aria-label={self ? 'Your items' : 'Shared items'} action={self && onShareNode ? 'Share' : undefined}
            items={nodes.map((n) => ({ id: n.id, title: n.title,
              description: [n.kind, sharing?.provenance[n.id] ? PROVENANCE[sharing.provenance[n.id]!] : null].filter(Boolean).join(' · ') }))}
            onOpen={(row) => {
              const node = nodes.find((n) => n.id === row.id);
              if (!node) return;
              if (self && onShareNode) onShareNode(node, refresh); else onOpenNode?.(node, node.href);
            }}
            data-testid="plane-person-items" />
        </Stack>
      )}
      {self && sharing?.viewer === 'owner' && <SharingGrants sharing={sharing} onChanged={refresh} />}
    </Stack>
  );
}
