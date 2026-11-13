// The call assistant in the shell (docs/meeting-assistant-design.md, decisions 8 and 13):
//   NovaBarControls  Invite Nova, the "Nova is listening" mark, Pause/Resume and Dismiss — the HuddleBar's `extras`
//   NovaNotice       the transcription notice for someone who has not acknowledged, above the footer row
//   useNovaRosterEntry  the "Nova (Assistant, listening)" line for the call's people lists
// Everything renders nothing unless the server advertises the feature (session.meetingAssistant) and a call is live.

import { Banner, Button, Chip, Inline, T, Tooltip } from '@connorhoehn/ui-components/shared';
import { useMeetingAssistant } from '../../lib/meetingAssistant';
import { assistantPresent, assistantStateWords, noticeText, noticeVisible, rosterEntry } from '../../lib/meetingAssistantModel';
import { useCallHost } from '../../lib/conversationCall';

/** The live call's id, or null while there is no joined call to listen to. */
function useLiveCallId(): string | null {
  const host = useCallHost();
  const call = host?.call;
  const joined = !!call && (call.phase === 'live' || call.phase === 'connecting' || call.phase === 'reconnecting');
  return joined ? call.call?.callId ?? null : null;
}

export function NovaBarControls() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  const { controls, view, busy } = nova;
  if (controls.hidden) return null;
  const words = assistantStateWords(view);
  return <Inline gap="xs" align="center" wrap={false} className="shrink-0" data-testid="nova-bar">
    {controls.invite && <Tooltip content="Nova listens to this call and answers when asked by name" placement="top">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void nova.invite()} data-testid="nova-invite">Invite Nova</Button>
    </Tooltip>}
    {words && <Chip size="sm" tone={view.phase === 'paused' ? 'neutral' : controls.left ? 'neutral' : 'info'} data-testid={controls.left ? 'nova-left' : 'nova-mark'}
      data-phase={view.phase}>{words}</Chip>}
    {controls.pause && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void nova.pause()} data-testid="nova-pause">Pause Nova</Button>}
    {controls.resume && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void nova.resume()} data-testid="nova-resume">Resume Nova</Button>}
    {controls.dismiss && <Button variant="ghost" size="sm" disabled={busy} onClick={() => void nova.dismiss()} data-testid="nova-dismiss">Dismiss Nova</Button>}
    {/* Package 4: the minutes ceiling line ("Nova leaves in 12 min") goes here. */}
    <span hidden data-testid="nova-ceiling-slot" />
    {nova.error && <T size="xs" tone="danger" role="alert" className="max-w-[12rem] truncate" title={nova.error} data-testid="nova-error">{nova.error}</T>}
  </Inline>;
}

/** The notice. RecordingConsentNotice cannot carry this text or a second action (see the package report), so it is a library Banner. */
export function NovaNotice() {
  const callId = useLiveCallId();
  const nova = useMeetingAssistant(callId);
  if (!noticeVisible(nova.enabled, nova.view)) return null;
  const text = noticeText(nova.view);
  return <Banner variant="info" layout="callout" icon title={text.title} className="mx-4 my-1" data-testid="nova-notice"
    action={<Inline gap="xs" wrap={false}>
      <Button variant="primary" size="sm" disabled={nova.busy} onClick={() => void nova.acknowledge()} data-testid="nova-ack">I understand</Button>
      <Button variant="secondary" size="sm" disabled={nova.busy} onClick={() => void nova.dismiss()} data-testid="nova-notice-dismiss">Dismiss Nova</Button>
    </Inline>}>
    {text.body}
  </Banner>;
}

/** Nova as a non-media entry for the call's people lists; null when it is not in this call. */
export function useNovaRosterEntry(callId: string | null): string | null {
  const nova = useMeetingAssistant(callId);
  return nova.enabled && assistantPresent(nova.view) ? rosterEntry(nova.view) : null;
}
