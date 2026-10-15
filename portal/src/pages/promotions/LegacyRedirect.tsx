// The retired Promotions inbox: its runbook rung is now Proposals (a run's
// proposal becomes a runbook version), so every /iq/promotions URL lands there.
import { Navigate } from 'react-router';

export default function PromotionsLegacyRedirect() {
  return <Navigate to="/iq/runbooks/proposals" replace />;
}
