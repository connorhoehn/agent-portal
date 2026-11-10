// /social/profile (UX walk D, 9 November 2026): how you appear to the people in
// Social, and your presence. It replaced a registration stub that named an
// internal lane. Name and picture come from your sign-in (the Social directory's
// `me`, the footer's own source); status and the status line are written to the
// shell's one presence entry, the same writers voice `set_status` uses, so a
// change shows on every peer's footer faces. "Do not disturb" is the busy status.
// All wording lives in profileModel.ts. Library composites only.

import { useEffect, useState } from 'react';
import { useGatewayOptional } from '@connorhoehn/realtime-modules/client';
import {
  Avatar, Button, FormField, Inline, InlineAlert, Input, PageFrame, PageSection, PresenceDot, RadioGroup, Stack, T,
} from '@connorhoehn/ui-components/shared';
import { useFlushTrailItems } from '../../components/shell/FlushPage';
import { useEmbeddedSocial } from '../../components/shell/EmbeddedSocial';
import { useSession } from '../../lib/auth';
import { toastSuccess } from '../../lib/toastStore';
import { loadSocialStatus } from '../../lib/socialStatusStore';
import {
  PROFILE_STATUS_OPTIONS, STATUS_MESSAGE_MAX, initialStatus, profileUnavailableReason, roleLine, statusMessageValue,
  type ProfileStatus,
} from './profileModel';

export default function ProfilePage() {
  const trail = useFlushTrailItems();
  const { session } = useSession();
  const social = useEmbeddedSocial();
  const gateway = useGatewayOptional();
  const self = social?.presencePeople.find((p) => p.id === session?.sub) ?? null;
  const name = social?.me?.displayName ?? session?.name ?? session?.sub ?? 'You';
  const avatarUrl = self?.avatarUrl ?? social?.people.find((p) => p.userId === session?.sub)?.avatarUrl;
  const reason = profileUnavailableReason({
    hasSocialGrant: (session?.grants.social?.length ?? 0) > 0,
    gatewayConfigured: !!gateway,
    presenceReady: !!social?.presence,
  });
  // What peers see comes from the presence metadata the footer reads; the kept
  // status only tells "busy" from "away", which the roster does not (E4).
  const savedStatus = loadSocialStatus(session?.sub ?? '')?.status ?? null;
  const [status, setStatus] = useState<ProfileStatus>(() => initialStatus(self, savedStatus));
  const [message, setMessage] = useState(self?.detail ?? '');
  const [touched, setTouched] = useState(false);
  // Until the person edits, follow what peers see (the roster arrives after the page).
  useEffect(() => {
    if (touched) return;
    setStatus(initialStatus(self, savedStatus));
    setMessage(self?.detail ?? '');
  }, [touched, self?.idle, self?.detail, savedStatus]);

  const save = () => {
    const presence = social?.presence;
    if (!presence) return;
    presence.setStatus(status);
    presence.updateMetadata({ statusMessage: statusMessageValue(message) });
    setTouched(false);
    toastSuccess(null, 'Status updated', PROFILE_STATUS_OPTIONS.find((o) => o.value === status)?.description);
  };

  return (
    <PageFrame title="Profile" description="How you appear to people in Social, and whether they can reach you now." breadcrumbs={trail} data-testid="social-profile">
      <Stack gap="lg" className="max-w-2xl">
        <PageSection size="sm" title="You">
          <Inline gap="md" align="center" data-testid="social-profile-identity">
            <Avatar name={name} size={48} {...(avatarUrl ? { src: avatarUrl } : {})} />
            <Stack gap="none" className="min-w-0">
              <T size="base" weight="semibold" tone="primary">{name}</T>
              <T size="sm" tone="secondary">{roleLine(session?.grants.social?.[0])}</T>
              <Inline gap="xs" align="center">
                <PresenceDot state={reason ? 'offline' : status} pulse={false} size="sm" />
                <T size="xs" tone="secondary" data-testid="social-profile-presence">
                  {reason ? 'Not connected to presence' : PROFILE_STATUS_OPTIONS.find((o) => o.value === status)?.label}
                </T>
              </Inline>
            </Stack>
          </Inline>
          <T size="xs" tone="tertiary" className="mt-2 block">Your name and picture come from your sign-in.</T>
        </PageSection>
        <PageSection size="sm" title="Status" description="What people see beside your name in Social, on the footer and in conversations.">
          <Stack gap="sm" data-testid="social-profile-status-form">
            {reason && <InlineAlert tone="info" data-testid="social-profile-unavailable">{reason}</InlineAlert>}
            <RadioGroup name="social-profile-status" value={status} disabled={!!reason}
              onChange={(v) => { setStatus(v); setTouched(true); }}
              options={PROFILE_STATUS_OPTIONS.map((o) => ({ ...o }))} data-testid="social-profile-status" />
            <FormField label="Status line" hint={`Optional, up to ${STATUS_MESSAGE_MAX} characters. Leave empty to clear it.`}>
              {(w) => <Input {...w} value={message} maxLength={STATUS_MESSAGE_MAX} disabled={!!reason} placeholder="Out until Thursday"
                onChange={(e) => { setMessage(e.target.value); setTouched(true); }} data-testid="social-profile-message" />}
            </FormField>
            <Inline gap="sm">
              <Button size="sm" variant="primary" disabled={!!reason || !touched} title={reason ?? (touched ? undefined : 'Change your status or status line first')}
                onClick={save} data-testid="social-profile-save">Save status</Button>
            </Inline>
          </Stack>
        </PageSection>
      </Stack>
    </PageFrame>
  );
}
