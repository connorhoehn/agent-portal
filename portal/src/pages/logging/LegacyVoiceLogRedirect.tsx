// G37: the Voice log became System › Logging. Its old addresses, bookmarked or
// spoken before the rename, land on the same record: /iq/voice-log → /iq/logging,
// /iq/voice-log/<id> → /iq/logging/voice/<id>, the query kept.
import { Navigate, useLocation, useParams } from 'react-router';
import { legacyVoiceLogTarget } from './loggingModel';

export default function LegacyVoiceLogRedirect() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { search } = useLocation();
  return <Navigate to={legacyVoiceLogTarget(sessionId, search)} replace />;
}
