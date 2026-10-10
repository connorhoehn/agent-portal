// The bodies of the Communication plane's far-right detail pane
// (docs/communication-plane-goal.md §2, §4): a shared item, a work-graph node.
// Each shows what the reader may know and offers "Open page" only where the
// reader's own resolution named one — never a link built from a stored title.

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { Button, ExternalLinkIcon, Inline, MetaLine, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { useSession } from '../../lib/auth';
import { CHOOSER } from '../../lib/tenantHome';
import { sharedKindLabel, sharedUnavailableReason } from '../../pages/social/sharedWorkModel';
import type { SharedWorkOpen } from '../../pages/social/SharedWorkView';

/**
 * A detail on the Communication plane, opened in the shell's far-right pane
 * (the library `SidePane`, page-owned: × closes it, any navigation closes it).
 */
export interface PlaneDetail {
  /** Stable identity of what is open (`person:u-mira`, `shared:<message id>`). */
  key: string;
  title: string;
  subtitle?: string;
  body: ReactNode;
}

function OpenPage({ href, testId = 'plane-detail-open-page' }: { href: string; testId?: string }) {
  const navigate = useNavigate();
  const { session } = useSession();
  // An orgiq page from another tenant goes through the workspace chooser (an explicit switch).
  const target = href.startsWith('/iq/') && session?.tenant !== 'orgiq' && session?.role !== 'admin' ? `${CHOOSER}?to=${encodeURIComponent(href)}` : href;
  return (
    <Button variant="secondary" size="sm" onClick={() => navigate(target)} data-testid={testId}>
      <Inline gap="xs" align="center" wrap={false}>Open page<ExternalLinkIcon size={14} /></Inline>
    </Button>
  );
}

const when = (iso: string | null | undefined) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null;
};

function SharedItemBody({ open, onShowInChat }: { open: SharedWorkOpen; onShowInChat: () => void }) {
  const { item } = open;
  // The wire item's kind, in the pane's vocabulary: a page reference (initiative / work item) is a "page".
  const paneKind = item.kind === 'initiative' || item.kind === 'work-item' ? 'page' : item.kind;
  const available = item.status === 'available' && !!item.title;
  return (
    <Stack gap="md" className="p-3" data-testid="plane-shared-detail" data-kind={paneKind}>
      <MetaLine size="sm" tone="secondary" items={[sharedKindLabel(item), item.sharedBy ? `shared by ${item.sharedBy.displayName}` : null, when(item.at),
        item.provenance === 'grant:historical' ? 'shared earlier' : null]} />
      {available
        ? <T size="sm" weight="medium" wrap data-testid="plane-shared-detail-reference">{item.title}</T>
        : <T size="sm" weight="medium" wrap tone="secondary" data-testid="plane-shared-detail-unavailable">{sharedKindLabel(item)} unavailable</T>}
      {!available && <T size="xs" tone="tertiary" wrap>{sharedUnavailableReason(item)}</T>}
      {available && item.href && <OpenPage href={item.href} />}
      {item.ref.messageId && <Button variant="link" size="sm" onClick={onShowInChat} data-testid="plane-shared-detail-in-chat">Show in the conversation</Button>}
    </Stack>
  );
}

/** A shared item (`Shared work` view row) as pane detail. */
export function sharedItemDetail(open: SharedWorkOpen, onShowInChat: () => void): PlaneDetail {
  const { item } = open;
  const title = item.status === 'available' && item.title ? item.title : `${sharedKindLabel(item)} unavailable`;
  return { key: `shared:${item.key}`, title, subtitle: sharedKindLabel(item), body: <SharedItemBody open={open} onShowInChat={onShowInChat} /> };
}

/** A work-graph node as pane detail. */
export function workNodeDetail(node: { id: string; title: string; kind: string }, href: string | null): PlaneDetail {
  return {
    key: `node:${node.id}`, title: node.title, subtitle: node.kind,
    body: (
      <Stack gap="md" className="p-3" data-testid="plane-node-detail" data-node={node.id}>
        <MetaLine size="sm" tone="secondary" items={[node.kind]} />
        {href ? <OpenPage href={href} /> : <T size="xs" tone="tertiary" wrap>This item has no page of its own.</T>}
      </Stack>
    ),
  };
}
