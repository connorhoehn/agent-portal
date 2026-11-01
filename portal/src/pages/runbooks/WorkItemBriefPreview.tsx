// A preview opens beside the work item, with its own scrolling surface.
import { useNavigate } from 'react-router';
import { Button, ChevronIcon, Inline, LoadingState, T } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { BriefDocument } from './BriefDocument';
import type { Brief, BriefSkillDetail } from './types';

export function WorkItemBriefPreview({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { can } = useCapabilities();
  if (!can('ViewSessionBrief')) return null;
  return <Inline gap="md" align="center" wrap data-testid="work-item-brief-preview">
    <Button variant={open ? 'secondary' : 'ghost'} size="sm" onClick={onToggle}
      aria-expanded={open} aria-controls="work-item-brief-pane" aria-label={open ? 'Close brief preview' : 'Open brief preview in side pane'}>
      <ChevronIcon dir={open ? 'down' : 'right'} size={14} />Brief preview
    </Button>
    <T size="xs" tone="secondary">What a run would be told for this item</T>
  </Inline>;
}

export function WorkItemBriefPane({ workItemId }: { workItemId: string }) {
  const { can } = useCapabilities();
  const navigate = useNavigate();
  const allowed = can('ViewSessionBrief');
  const feed = useFetch<{ brief: Brief; skills?: BriefSkillDetail[] }>(allowed ? `/api/work-items/${encodeURIComponent(workItemId)}/brief-preview` : null, 0);
  if (!allowed) return <T size="sm" tone="secondary">Your role cannot view this brief.</T>;
  return <div id="work-item-brief-pane">{feed.error ? <UnavailableNotice error={feed.error} what="the brief preview" source="The preview is assembled from the runbook store and this work item" onRetry={feed.refresh} />
    : !feed.data ? <LoadingState label="Assembling the brief…" />
      : <BriefDocument brief={feed.data.brief} frozen={false} skills={feed.data.skills} onOpen={(href) => navigate(href)} />}</div>;
}
