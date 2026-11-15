// The live call's id, or null while there is no joined call to listen to. Milo's footer pieces all key on it.
import { useCallHost } from './conversationCall';

export function useLiveCallId(): string | null {
  const host = useCallHost();
  const call = host?.call;
  const joined = !!call && (call.phase === 'live' || call.phase === 'connecting' || call.phase === 'reconnecting');
  return joined ? call.call?.callId ?? null : null;
}
