// /interviews/rounds/:id — where a round's bell leads (docs/interviews-tenant-plan.md row I1.4). The bell names no
// candidate (the notification store is shared by every tenant), so it carries the round, and this resolves the
// round to its candidate's profile for whoever may read it; anyone else gets the usual not-found.

import { LoadingState } from '@connorhoehn/ui-components/shared';
import { Navigate, useNavigate, useParams } from 'react-router';
import { RecordNotFound, UnavailableNotice } from '../../components/UnavailableNotice';
import { useFetch } from '../../hooks/useFetch';
import { INTERVIEWS_API, candidateHref, type InterviewRow } from '../../lib/interviews';

export default function RoundRedirectPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, error, refresh } = useFetch<{ interview: InterviewRow }>(id ? `${INTERVIEWS_API}/interviews/${encodeURIComponent(id)}` : null);
  if (data?.interview) return <Navigate to={candidateHref(data.interview.candidate.id)} replace />;
  if (error) {
    return /404|not found/i.test(error)
      ? <RecordNotFound heading="Round" title="Round not found" body="There is no round here that you can open." backLabel="Home" onBack={() => navigate('/interviews')} />
      : <UnavailableNotice error={error} what="this round" source="Rounds are read from the interviews tenant" onRetry={refresh} />;
  }
  return <LoadingState label="Opening the round…" />;
}
