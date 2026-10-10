// The page-reference card a chat message carries (initiative-huddle-shell
// mockup): a document glyph, the page's title, and its trail —
// "Auth Migration › Work › WI-AUTH-E2-B3". One renderer for every chat surface
// that shows these messages (huddle chat, Social DMs, an assessment team's
// Discussion — whose references name a scorecard dimension: "Teams › Team A"),
// so a reference reads the same wherever it lands.
//
// Everything drawn here comes from a reference the BFF resolved for THIS
// viewer (`readCallChatPageReference` validated it); the message itself only
// stored `{kind,id}`. Nothing is derived from the sender's titles.

import type { ReactNode } from 'react';
import type { ChatMessage } from '@connorhoehnslalom/realtime-modules/client';
import { Button, Card, DocumentIcon, Inline, Stack, T } from '@connorhoehnslalom/ui-components/shared';
import { readCallChatPageReference, type CallChatPageReference } from '../../lib/callPages';
import type { AssessmentDimensionPageReference } from '../../lib/assessmentPageReferences';

/** Every reference kind a chat message can carry, as resolved for this reader. */
export type ChatPageReference = CallChatPageReference | AssessmentDimensionPageReference;
type AvailableReference = Extract<ChatPageReference, { status: 'available' }>;

/** "Auth Migration › Work › WI-AUTH-E2-B3"; an initiative reads "Initiatives › Auth Migration"; a dimension "Teams › Team A". */
export function pageReferenceTrail(reference: AvailableReference): string {
  if (reference.kind === 'assessment-dimension') return ['Teams', reference.team.name].join(' › ');
  return reference.kind === 'work-item'
    ? [reference.project.title, reference.key ?? reference.title].join(' › ')
    : ['Initiatives', reference.project.title].join(' › ');
}

export interface PageReferenceCardProps {
  /** A resolved reference, or null while it loads. */
  reference: ChatPageReference | null;
  loading?: boolean;
  /** Absent: the card is a record, not a way in. */
  onOpen?: (reference: AvailableReference) => void;
  /** Test id of the title (clicking it opens); the card's button is `<id>-card`. */
  openTestId?: string;
  /** Test id of the unavailable/loading state. */
  unavailableTestId?: string;
  /** Beside the card — a Retry. */
  action?: ReactNode;
}

export function PageReferenceCard({
  reference, loading = false, onOpen, openTestId = 'page-reference-open',
  unavailableTestId = 'page-reference-unavailable', action,
}: PageReferenceCardProps) {
  if (reference?.status !== 'available') {
    return <Inline gap="xs" align="center">
      <Card padding="sm" className="max-w-sm text-text-muted" data-testid={unavailableTestId}>
        <Inline gap="sm" align="center" wrap={false}>
          <DocumentIcon size={18} aria-hidden="true" className="shrink-0" />
          <T className="text-xs text-text-muted">{loading ? 'Loading page…' : 'Page unavailable'}</T>
        </Inline>
      </Card>
      {action}
    </Inline>;
  }
  const trail = pageReferenceTrail(reference);
  const body = <Inline gap="sm" align="center" wrap={false} className="min-w-0">
    <DocumentIcon size={16} aria-hidden="true" className="shrink-0 text-primary" />
    <Stack gap="none" className="min-w-0 text-left">
      <T className="truncate text-xs font-medium text-text-primary" data-testid={openTestId}>{reference.title}</T>
      <T className="truncate text-xs text-text-muted">{trail}</T>
    </Stack>
  </Inline>;
  return <Inline gap="xs" align="center">
    <Card padding="none" className="min-w-0 max-w-sm" data-testid="page-reference-card">
      {onOpen
        ? <Button variant="ghost" className="h-auto w-full min-w-0 justify-start px-2 py-1.5" title={`${reference.title} — ${trail}`}
            onClick={() => onOpen(reference)} data-testid={`${openTestId}-card`}>{body}</Button>
        : <Stack gap="none" className="px-2 py-1.5">{body}</Stack>}
    </Card>
    {action}
  </Inline>;
}

/**
 * `ChatPanel.renderMessageReferences` for messages whose metadata carries a
 * BFF-resolved `pageReference` (huddle chat). Messages without one draw nothing.
 */
export function renderPageReference(
  onOpen: (reference: AvailableReference) => void,
  testIds: { open?: string; unavailable?: string } = {},
): (message: ChatMessage) => ReactNode {
  return message => {
    const reference = readCallChatPageReference(message.metadata?.pageReference);
    if (!reference) return null;
    return <PageReferenceCard reference={reference} onOpen={onOpen}
      {...(testIds.open ? { openTestId: testIds.open } : {})}
      {...(testIds.unavailable ? { unavailableTestId: testIds.unavailable } : {})} />;
  };
}
