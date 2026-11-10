// /social/profile, as data (UX walk D, 9 November 2026): the page replaced a
// registration stub that named an internal lane. It shows how the viewer
// appears in Social — name, picture, presence and a status line — and sets
// the presence status and its message on the shell's one presence entry (the
// same writers the voice `set_status` tool uses). "Busy" is the workspace's
// do-not-disturb: peers see the busy dot and the status line.
//
// Pure: no React, so node:test runs it.

export type ProfileStatus = 'online' | 'away' | 'busy';

export const PROFILE_STATUS_OPTIONS: ReadonlyArray<{ value: ProfileStatus; label: string; description: string }> = [
  { value: 'online', label: 'Available', description: 'People see you as online.' },
  { value: 'away', label: 'Away', description: 'People see you as away; messages still reach you.' },
  { value: 'busy', label: 'Do not disturb', description: 'People see you as busy and your status line.' },
];

/** The longest status line the presence roster keeps (knowledgeFormat.presenceAvatarUsers trims to 120). */
export const STATUS_MESSAGE_MAX = 120;

/** Why status cannot be set right now, or null when it can. */
export function profileUnavailableReason(input: { hasSocialGrant: boolean; gatewayConfigured: boolean; presenceReady: boolean }): string | null {
  if (!input.hasSocialGrant) return 'Your account has no Social access, so you have no presence here.';
  if (!input.gatewayConfigured) return 'Presence needs the realtime gateway, which is not configured on this deployment.';
  if (!input.presenceReady) return 'Connecting to presence… your status can be set once it is connected.';
  return null;
}

/** The status the page starts from: what peers see now (an idle entry reads as away). */
export function initialStatus(self: { idle?: boolean } | null | undefined): ProfileStatus {
  return self?.idle ? 'away' : 'online';
}

/** The message as it is sent: trimmed, capped, empty clears it. */
export function statusMessageValue(text: string): string | null {
  const t = text.trim().slice(0, STATUS_MESSAGE_MAX);
  return t.length > 0 ? t : null;
}

/** The role line under the name ("Participant in Social"). */
export function roleLine(role: string | null | undefined): string {
  if (!role) return 'No Social role';
  const label = role.split('-').map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(' ');
  return `${label} in Social`;
}
