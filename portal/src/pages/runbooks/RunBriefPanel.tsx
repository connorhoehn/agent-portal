// A run's frozen brief, fetched by the run's job reference (GET /api/runs/:ref/brief). A run that was
// never given one (older than the feature, or not a job) says so rather than showing an empty tab.
import { useNavigate } from 'react-router';
import { EmptyState, LoadingState } from '@connorhoehnslalom/ui-components/shared';
import { UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { BriefDocument } from './BriefDocument';
import type { Brief } from './types';

export function RunBriefPanel({ runRef }: { runRef: string }) {
  const navigate = useNavigate();
  const feed = useFetch<{ brief: Brief }>(`/api/runs/${encodeURIComponent(runRef)}/brief`, 0);
  if (feed.error && /no brief|404|NO_BRIEF/i.test(feed.error)) {
    return <EmptyState align="start" title="No brief was frozen for this run" description="Runs started before runbooks existed, and runs that are not agent jobs, were given no brief." data-testid="run-brief-none" />;
  }
  if (feed.error) return <UnavailableNotice error={feed.error} what="this run’s brief" source="Briefs are read from the runbook store" onRetry={feed.refresh} />;
  if (!feed.data) return <LoadingState label="Loading brief…" />;
  return <BriefDocument brief={feed.data.brief} frozen onOpen={(href) => navigate(href)} />;
}
