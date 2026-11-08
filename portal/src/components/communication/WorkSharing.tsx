// Sharing your own work from the Communication plane
// (docs/communication-plane-goal.md §3, "Wire shapes (Lane A)"):
//
//   - ShareNodeForm: the work graph's share affordance (`onRequestCollaboration`
//     on your own graph) → pick a conversation you can post to
//     (GET /api/social/share-destinations) → POST /api/social/plane/work-sharing
//     `{ audience: { kind: 'conversation', id }, nodeIds: [node] }`. The BFF
//     checks PostMessage and that you are in the audience now.
//   - SharingGrants: your grants, each with Stop (POST …/work-sharing/:id/
//     transition `{ action: 'stop', expectedRevision }`); a stale revision is a
//     409 the list explains and refreshes on.
//
// Library composites only: Select, Button, ActionRowList (size sm), InlineAlert.

import { useState } from 'react';
import { useNavigate } from 'react-router';
import { ActionRowList } from '@connorhoehn/ui-components';
import { Button, InlineAlert, Inline, MetaLine, SectionLabel, Select, Stack, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { writeJson } from '../../lib/writeJson';
import { readShareDestinations } from '../../lib/shareToSocial';
import type { SharingEnvelope, SharingGrant } from './planeSharingModel';

export function ShareNodeForm({ node, href, onShared }: { node: { id: string; title: string }; href?: string | null; onShared: () => void }) {
  const navigate = useNavigate();
  const destinations = useFetch<unknown>('/api/social/share-destinations', 60_000, { share: true });
  const list = readShareDestinations(destinations.data);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const share = async () => {
    if (!target) return;
    setBusy(true); setError(null);
    const res = await writeJson('/api/social/plane/work-sharing', 'POST', { audience: { kind: 'conversation', id: target }, nodeIds: [node.id] });
    setBusy(false);
    if (!res.ok) { setError(res.error ?? 'The work could not be shared.'); return; }
    setDone(true); onShared();
  };
  return (
    <Stack gap="md" className="p-3" data-testid="plane-share-form" data-node={node.id}>
      <T size="sm" tone="secondary" wrap>Everyone in the conversation you choose sees this on your shared work for a day. Stop sharing whenever you like.</T>
      <Select aria-label="Share with" placeholder={destinations.data ? 'Choose a conversation' : 'Loading…'} value={target} size="sm"
        onChange={(e) => setTarget(e.target.value)} options={list.map((d) => ({ value: d.channel, label: d.kind === 'channel' ? `#${d.slug ?? d.label}` : d.label }))}
        data-testid="plane-share-target" />
      {error && <InlineAlert tone="error">{error}</InlineAlert>}
      {done && <InlineAlert tone="success">Shared.</InlineAlert>}
      <Inline gap="sm">
        <Button variant="primary" size="sm" disabled={!target || busy || done} onClick={() => void share()} data-testid="plane-share-submit">Share</Button>
        {href && <Button variant="secondary" size="sm" onClick={() => navigate(href)} data-testid="plane-detail-open-page">Open page</Button>}
      </Inline>
    </Stack>
  );
}

const audienceLabel = (g: SharingGrant, labelOf: (channel: string) => string) =>
  !g.audience ? 'an audience you can no longer see' : g.audience.kind === 'team' ? 'a team' : labelOf(g.audience.id);

export function SharingGrants({ sharing, onChanged }: { sharing: SharingEnvelope; onChanged: () => void }) {
  const destinations = useFetch<unknown>('/api/social/share-destinations', 60_000, { share: true });
  const labelOf = (channel: string) => {
    const d = readShareDestinations(destinations.data).find((x) => x.channel === channel);
    return d ? (d.kind === 'channel' ? `#${d.slug ?? d.label}` : d.label) : 'a conversation';
  };
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const stop = async (g: SharingGrant) => {
    setBusy(g.id); setError(null);
    const res = await writeJson(`/api/social/plane/work-sharing/${encodeURIComponent(g.id)}/transition`, 'POST', { action: 'stop', expectedRevision: g.revision });
    setBusy(null);
    if (!res.ok) setError(res.status === 409 ? 'That share changed elsewhere; the list is refreshed.' : res.error ?? 'Sharing could not be stopped.');
    onChanged();
  };
  const live = sharing.grants.filter((g) => g.state === 'active' || g.state === 'paused');
  return (
    <Stack gap="sm" data-testid="plane-sharing-grants">
      <SectionLabel as="h2">What you share</SectionLabel>
      {error && <InlineAlert tone="warning">{error}</InlineAlert>}
      <ActionRowList action="Stop" aria-label="What you share"
        items={live.map((g) => ({
          id: g.id, title: `With ${audienceLabel(g, labelOf)}`,
          description: <MetaLine size="xs" tone="tertiary" items={[`${g.nodeIds.length} ${g.nodeIds.length === 1 ? 'item' : 'items'}`, g.state === 'paused' ? 'paused' : null, g.expiresAt ? `until ${new Date(g.expiresAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : null]} />,
          ...(busy === g.id ? { disabled: true, disabledReason: 'Stopping…' } : {}),
        }))}
        emptyLabel="You are not sharing anything right now. Open a node on your graph and share it with a conversation."
        onOpen={(row) => { const g = live.find((x) => x.id === row.id); if (g) void stop(g); }}
        data-testid="plane-sharing-grant-list" />
    </Stack>
  );
}
