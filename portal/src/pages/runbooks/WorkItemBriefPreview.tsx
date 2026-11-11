// A preview opens beside the work item, with its own scrolling surface. It leads with the runbooks the next
// run would get (with the pin control and earlier attempts), then the instructions text itself.
import { useNavigate } from 'react-router';
import { Button, ChevronIcon, Inline, LoadingState, Stack, T } from '@connorhoehn/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { BriefDocument } from './BriefDocument';
import { WorkItemRunbooks } from './WorkItemRunbooks';
import type { BriefPreviewResponse } from './types';

const previewUrl = (id: string) => `/api/work-items/${encodeURIComponent(id)}/brief-preview`;

export function WorkItemBriefPreview({ open, onToggle, workItemId }: { open: boolean; onToggle: () => void; workItemId?: string }) {
  const { can } = useCapabilities();
  const allowed = can('ViewSessionBrief');
  const feed = useFetch<BriefPreviewResponse>(allowed && workItemId ? previewUrl(workItemId) : null, 0, { share: true });
  if (!allowed) return null;
  const names = feed.data?.offer.runbooks.map((r) => r.title) ?? [];
  return <Stack gap="sm" data-testid="work-item-brief-preview">
    <Inline gap="md" align="center" wrap>
      <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={onToggle}
        aria-expanded={open} aria-controls="work-item-brief-pane" aria-label={open ? 'Close brief preview' : 'Open brief preview in side pane'}>
        <ChevronIcon dir={open ? 'down' : 'right'} size={14} />Brief preview
      </Button>
      <T size="xs" tone="secondary" data-testid="work-item-brief-summary">
        {feed.data
          ? names.length > 0 ? `A run would get ${names.length === 1 ? 'one runbook' : `${names.length} runbooks`}: ${names.join('; ')}` : 'A run would get no runbook'
          : 'What a run would be told for this item'}
      </T>
    </Inline>
  </Stack>;
}

export function WorkItemBriefPane({ workItemId }: { workItemId: string }) {
  const { can } = useCapabilities();
  const navigate = useNavigate();
  const allowed = can('ViewSessionBrief');
  const feed = useFetch<BriefPreviewResponse>(allowed ? previewUrl(workItemId) : null, 0, { share: true });
  if (!allowed) return <T size="sm" tone="secondary">Your role cannot view this brief.</T>;
  return <Stack gap="lg" id="work-item-brief-pane" className="min-h-0 flex-1">{feed.error ? <UnavailableNotice error={feed.error} what="the brief preview" source="The preview is assembled from the runbook store and this work item" onRetry={feed.refresh} />
    : !feed.data ? <LoadingState label="Assembling the brief…" />
      : <>
        <WorkItemRunbooks workItemId={workItemId} preview={feed.data} onChanged={feed.refresh} />
        <BriefDocument presentation="pane" brief={feed.data.brief} frozen={false} skills={feed.data.skills} onOpen={(href) => navigate(href)} />
      </>}</Stack>;
}
