// Settings → Profile (plan D7): where the Mine view's "Check profile" lands.
//
// It answers "why is my Mine view empty?" from the account side: who is
// signed in, and whether that account is connected to a team profile. An
// unconnected account is the most common reason; the fix is an admin linking
// it in Identity → Users, so hr-admin (ManageUsers) gets that door directly.
//
// All wording and state live in profileModel.ts. This file only fetches and
// draws. A failed read is drawn as a failed read — the model never turns one
// into "Not connected".

import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  Card, Divider, SectionLabel, Button, Inline, InlineAlert, T,
} from '@connorhoehnslalom/ui-components/shared';
import { SettingRow } from '../../components/settings';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { useCapabilities } from '../../lib/capabilities';
import { personPath } from '../project-detail/PersonRef';
import {
  buildProfile, PROFILE_ANCHOR,
  type SessionMe, type SessionPerson, type PersonName,
} from './profileModel';

const VALUE = 'text-sm text-text-secondary';
const PENDING = 'text-sm text-text-tertiary';

export function ProfileSection() {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const { session } = useSession();
  const { can } = useCapabilities();
  // The team profile is an org-graph person, an orgiq concept; the graph read
  // is refused to other tenants, so they get the identity row only.
  const orgiq = session?.tenant === 'orgiq';

  const me = useFetch<SessionMe>('/api/session/me');
  const person = useFetch<SessionPerson>(orgiq ? '/api/session/person' : null);
  const personId = person.data?.linked ? person.data.personId : null;
  const detail = useFetch<PersonName>(
    orgiq && personId ? `/api/graph/people/${encodeURIComponent(personId)}` : null,
  );

  const model = buildProfile({
    me: { data: me.data, error: me.error ?? me.degraded },
    person: { data: person.data, error: person.error ?? person.degraded },
    personDetail: personId ? { data: detail.data, error: detail.error } : undefined,
    canManageUsers: can('ManageUsers'),
  });

  // /settings#profile: bring the section into view and put focus on it, so a
  // keyboard or screen-reader user arriving from "Check profile" starts here.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (hash !== `#${PROFILE_ANCHOR}`) return;
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    el.focus({ preventScroll: true });
  }, [hash]);

  const { signedIn, connection, identityAction } = model;

  return (
    <Card
      padding="md"
      id={PROFILE_ANCHOR}
      ref={ref}
      tabIndex={-1}
      aria-label="Profile"
      className="scroll-mt-4 focus:outline-none"
      data-testid="settings-profile"
    >
      <SectionLabel as="div" className="mb-1">Profile</SectionLabel>
      <Divider spacing="none" className="mb-1" />

      <SettingRow
        title="Signed in as"
        control={
          signedIn.state === 'ok'
            ? <T className={VALUE} data-testid="profile-signed-in">{signedIn.label}</T>
            : <T className={PENDING}>{signedIn.state === 'loading' ? 'Loading…' : '—'}</T>
        }
      />
      {signedIn.state === 'error' && (
        <InlineAlert tone="error" data-testid="profile-me-error">
          Could not load who is signed in: {signedIn.error}{' '}
          <Button variant="link" size="sm" className="px-0" onClick={me.refresh}>Try again</Button>
        </InlineAlert>
      )}

      {orgiq && (
        <>
          <Divider spacing="none" />
          {connection.state === 'error' ? (
            <>
              <SettingRow title="Team profile" control={<T className={PENDING}>—</T>} />
              <InlineAlert tone="error" data-testid="profile-person-error">
                Could not check whether this account is connected to a team profile: {connection.error}{' '}
                <Button variant="link" size="sm" className="px-0" onClick={person.refresh}>Try again</Button>
              </InlineAlert>
            </>
          ) : connection.state === 'loading' ? (
            <SettingRow title="Team profile" control={<T className={PENDING}>Loading…</T>} />
          ) : connection.state === 'unlinked' ? (
            <SettingRow
              title="Team profile"
              description={connection.hint}
              control={<T className={VALUE} data-testid="profile-connection">{connection.text}</T>}
            />
          ) : (
            <SettingRow
              title="Team profile"
              description={
                connection.nameError
                  ? `Connected, but the profile's name could not be loaded (${connection.nameError}).`
                  : undefined
              }
              control={
                <Inline gap="xs" align="center" wrap={false} data-testid="profile-connection">
                  <T className={VALUE}>Connected to</T>
                  <Button
                    variant="link"
                    size="sm"
                    className="px-0"
                    onClick={() => navigate(personPath(connection.personId))}
                  >
                    {connection.name ?? (connection.nameError ? connection.personId : 'Loading…')}
                  </Button>
                </Inline>
              }
            />
          )}
        </>
      )}

      {identityAction && (
        <>
          <Divider spacing="none" />
          <SettingRow
            title="Account connections"
            description="Connect sign-in accounts to team profiles for everyone in the workspace."
            control={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => navigate(identityAction.href)}
                data-testid="profile-identity-link"
              >
                {identityAction.label}
              </Button>
            }
          />
        </>
      )}
    </Card>
  );
}
