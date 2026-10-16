// "Brief preview" on a work item: what a run would be given for this item if it started now
// (GET /api/work-items/:id/brief-preview). Fetched when opened; nothing is stored.
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Disclosure, LoadingState } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { useCapabilities } from '../../lib/capabilities';
import { BriefDocument } from './BriefDocument';
import type { Brief, BriefSkillDetail } from './types';

export function WorkItemBriefPreview({ workItemId }: { workItemId: string }) {
  const { can } = useCapabilities();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const feed = useFetch<{ brief: Brief; skills?: BriefSkillDetail[] }>(open ? `/api/work-items/${encodeURIComponent(workItemId)}/brief-preview` : null, 0);
  if (!can('ViewSessionBrief')) return null;
  return (
    <Disclosure summary="Brief preview" hint="What a run would be told for this item" variant="plain" density="compact" onToggle={setOpen} data-testid="work-item-brief-preview">
      {feed.error ? <UnavailableNotice error={feed.error} what="the brief preview" source="The preview is assembled from the runbook store and this work item" onRetry={feed.refresh} />
        : !feed.data ? <LoadingState label="Assembling the brief…" />
          : <BriefDocument brief={feed.data.brief} frozen={false} skills={feed.data.skills} onOpen={(href) => navigate(href)} />}
    </Disclosure>
  );
}
