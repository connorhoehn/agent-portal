// The Communication plane's Calls shelf (formerly the /iq/calls,
// /assessment/calls and /pipelines/calls page): the actor's call history
// across the active tenant's pages (page huddles on initiatives, teams,
// documents and runs), with the missed count. The same call-log rows Social's
// Calls pane lists, through the same library list (CallLogList); each row opens
// the page it happened on, where that page's Calls view lists the same calls.
// The BFF (`GET /api/calls/tenant`) asks the SOURCE tenant's own read action —
// not a Social grant — so this shelf is there for every role of the tenant.
import { useMemo } from 'react';
import { useNavigate } from 'react-router';
import { EmptyState, ErrorState, LoadingState } from '@connorhoehn/ui-components/shared';
import { CallLogList } from '@connorhoehn/ui-components/social';
import { useSession } from '../../lib/auth';
import { tenantCallEntries, type TenantCallEntry } from '../../lib/pageCalls';
import { usePeopleNames, type PageCallsState } from '../../hooks/usePageCalls';

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const WHERE: Record<string, string> = { orgiq: 'initiative', assessment: 'team or document', pipelines: 'run' };

export default function TenantCallLog({ calls }: { calls: PageCallsState }) {
  const navigate = useNavigate();
  const { session } = useSession();
  const { data, isLoading, error, refresh } = calls;
  const nameOf = usePeopleNames();
  const rows = useMemo(() => tenantCallEntries(data?.calls ?? [], session?.sub ?? '', nameOf), [data, session?.sub, nameOf]);
  const where = WHERE[session?.tenant ?? ''] ?? 'page';
  if (isLoading && !data) return <LoadingState label="Loading your calls…" />;
  if (error && !data) return <ErrorState title="Your calls could not be loaded" description={error} actionLabel="Try again" onAction={refresh} />;
  if (rows.length === 0) {
    return <EmptyState testId="tenant-calls-empty" align="start" title="No calls yet"
      description={`A huddle on a ${where} page appears here once you have joined it, and so does a call you missed.`} />;
  }
  return (
    <CallLogList
      rows={rows}
      callBackLabel={() => 'Open page'}
      onCallBack={(row) => { const href = (row as TenantCallEntry).href; if (href) navigate(href); }}
      formatWhen={when}
      data-testid="tenant-call-log"
    />
  );
}
