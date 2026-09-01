// Clicking a contributor used to navigate to /iq/explore?focus=…, which threw
// the user out of the initiative and dropped their breadcrumb trail. This keeps
// them in place: the person's title, skills, influence and top collaborators,
// with an explicit "Explore graph" that is now a choice rather than an accident.

import { useNavigate } from 'react-router';
import {
  Avatar,
  Button,
  Chip,
  Inline,
  InlineAlert,
  LoadingState,
  MetaLine,
  Modal,
  Stack,
} from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import type { PersonDetail } from './types';

/** The small uppercase caption above a block inside the card. No library
 *  primitive covers a bare section caption, so it lives here — on tokens, not
 *  on an inline style. */
function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] uppercase tracking-wide text-text-tertiary">{children}</span>
  );
}

export function ContributorModal({
  personId, roleLabel, onClose,
}: {
  personId: string;
  roleLabel: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  // Influence is ViewLeaderboard-tier analytics; this modal opens for every
  // role that can view an initiative's contributors.
  const { session } = useSession();
  const showAnalytics =
    session?.role === 'org-leader' || session?.role === 'hr-admin' || session?.role === 'admin';
  const { data: person, error } = useFetch<PersonDetail>(`/api/graph/people/${encodeURIComponent(personId)}`);

  const topCollaborators = (person?.connections ?? [])
    .slice()
    .sort((a, b) => b.strength - a.strength)
    .slice(0, 5);

  return (
    <Modal
      open
      onClose={onClose}
      ariaLabel={person ? `${person.name} details` : 'Contributor details'}
      maxWidth={460}
    >
      {error && (
        <InlineAlert tone="error" onDismiss={onClose}>
          Couldn't load this person.
        </InlineAlert>
      )}
      {!error && !person && <LoadingState label="Loading…" />}
      {person && (
        <Stack gap="md">
          <Inline gap="md" align="center" wrap={false}>
            <Avatar name={person.name} size={44} />
            <Stack gap="none" className="min-w-0 flex-1">
              <span className="text-[17px] font-semibold text-text-primary">{person.name}</span>
              <MetaLine size="sm" items={[person.title, person.department]} />
            </Stack>
            {roleLabel && <Chip tone="info">{roleLabel}</Chip>}
          </Inline>

          {person.skills.length > 0 && (
            <Stack gap="xs">
              <FieldLabel>Skills</FieldLabel>
              <Inline gap="xs">
                {person.skills.map((s) => <Chip key={s}>{s}</Chip>)}
              </Inline>
            </Stack>
          )}

          {showAnalytics && person.influenceScore != null && (
            <span className="text-[13px] text-text-secondary">
              Influence score{' '}
              <strong className="text-text-primary tabular-nums">{person.influenceScore}</strong>
            </span>
          )}

          {topCollaborators.length > 0 && (
            <Stack gap="xs">
              <FieldLabel>Top collaborators</FieldLabel>
              {topCollaborators.map((c) => (
                <Inline key={c.otherPerson.id} gap="sm" align="center" wrap={false}>
                  <Avatar name={c.otherPerson.name} size={22} />
                  <span className="text-[13px] text-text-primary">{c.otherPerson.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-text-tertiary">
                    {c.otherPerson.title ?? ''}
                  </span>
                  <span className="text-[12px] text-text-tertiary tabular-nums">
                    {Math.round(c.strength * 100)}%
                  </span>
                </Inline>
              ))}
            </Stack>
          )}

          <Button
            fullWidth
            variant="secondary"
            onClick={() => navigate(`/iq/explore?focus=${encodeURIComponent(person.id)}`)}
          >
            Explore {person.name.split(' ')[0]}'s graph →
          </Button>
        </Stack>
      )}
    </Modal>
  );
}
