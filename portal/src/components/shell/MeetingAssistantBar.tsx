// The call assistant in the shell (docs/meeting-assistant-design.md, decisions 8 and 13):
//   NovaBarControls  Invite Nova, the "Nova is listening" mark, Pause/Resume and Dismiss — the HuddleBar's `extras`
//   NovaNotice       the transcription notice for someone who has not acknowledged, above the footer row
//   useNovaRosterEntry  the "Nova (Assistant, listening)" line for the call's people lists
// Everything renders nothing unless the server advertises the feature (session.meetingAssistant) and a call is live.

import { Banner, Button, Chip, CloseIcon, DropdownMenu, Inline, PauseCircleIcon, PlayCircleIcon, T, Tooltip } from '@connorhoehn/ui-components/shared';
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
  return <Inline gap="xs" align="center" wrap={false} className="shrink-0 border-l border-border pl-2" data-testid="nova-bar">
    {controls.invite && <Tooltip content="Nova listens to this call and answers when asked by name" placement="top">
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => void nova.invite()} data-testid="nova-invite">Invite Nova</Button>
    </Tooltip>}
    {/* One compact control keeps the dense bar on a line: the state in words is the trigger, Pause/Resume and Dismiss are its menu. */}
    {words && controls.left && <Chip size="xs" tone="neutral" data-testid="nova-left">{words}</Chip>}
    {words && !controls.left && <DropdownMenu align="end" triggerVariant="secondary" triggerClassName="px-2" triggerLabel={`${words}. Pause, resume or dismiss Nova`} triggerTestId="nova-mark"
      triggerAttributes={{ 'data-phase': view.phase }} disabled={busy} data-testid="nova-menu"
      trigger={<T size="xs" weight="medium" className="whitespace-nowrap">{words}</T>}
      sections={[{ items: [
        ...(controls.pause ? [{ label: 'Pause Nova', icon: <PauseCircleIcon size={14} />, onSelect: () => void nova.pause() }] : []),
        ...(controls.resume ? [{ label: 'Resume Nova', icon: <PlayCircleIcon size={14} />, onSelect: () => void nova.resume() }] : []),
        ...(controls.dismiss ? [{ label: 'Dismiss Nova', icon: <CloseIcon size={14} />, danger: true, onSelect: () => void nova.dismiss() }] : []),
      ] }]} />}
    {/* Package 4: the minutes ceiling line ("Nova leaves in 12 min") goes here. */}
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
