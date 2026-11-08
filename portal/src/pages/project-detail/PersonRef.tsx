// A person's name, wherever it appears: hoverable, and a real link.
//
// Names were dead text (the work table) or ghost buttons that opened a modal
// (the header) — so the same person behaved differently depending on which
// row you found them in, and neither could be opened in a new tab, copied, or
// linked to. This is the one way a person is rendered on this page: a link to
// their node in the graph, with an Outlook-style people card that answers
// "who is this" on hover without spending a navigation to find out.
//
// The card is the library `HoverCard` (2.437.0), not `PersonHoverCard`:
// that component opens its panel on focus and its InlinePopover moves focus
// into the panel and traps Tab there, which made a table of person chips
// unusable past row 1 by keyboard (docs/orgiq-journeys/sme/DEFECTS.md #2).
// Here (`openOnFocus={false}`) focus alone never opens the card, Space (and
// Enter on a plain name) toggles a pin, Escape closes it without moving
// focus, and Tab always continues to the next control.
//
// Everyday cards use the existing self-disclosed demo profiles. Only a ready
// Work HR session requests inferred graph details, after a hover/pin opens.
// A table must not request person details for cards nobody looked at.

import { useState, type KeyboardEvent } from 'react';
import { Link } from 'react-router';
import { Avatar, Chip, HoverCard, Inline, LoadingState, Stack, T } from '@connorhoehn/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { PublicPersonSummary } from '../../components/people/PublicPersonSummary';
import type { PersonDetail } from './types';

/** Where a person's name goes when you click it. */
export function personPath(personId: string): string {
  return `/iq/explore?focus=${encodeURIComponent(personId)}`;
}

function InferredHoverDetail({ personId }: { personId: string }) {
  const { data, error } = useFetch<PersonDetail>(`/api/graph/people/${encodeURIComponent(personId)}`);
  if (error) return <T size="xs" className="text-text-tertiary">Couldn’t load details.</T>;
  if (!data) return <LoadingState label="Loading…" spinnerSize="sm" />;
  const skills = data.skills.slice(0, 5);
  return (
    <Stack gap="xs">
      {skills.length > 0 && (
        <Inline gap="xs">
          {skills.map((s) => <Chip key={s} size="xs">{s}</Chip>)}
        </Inline>
      )}
      <T size="xs" className="text-text-tertiary">
        Click the name to open {data.name.split(' ')[0]} in the graph.
      </T>
    </Stack>
  );
}

/** The identity block the card shows immediately, before any fetch. */
function PersonIdentity({ name, title, department, avatarUrl }: { name: string; title?: string | null; department?: string | null; avatarUrl?: string | null }) {
  return (
    <Inline gap="xs" align="center">
      <Avatar name={name} size={32} src={avatarUrl ?? undefined} />
      <Stack gap="none">
        <T size="sm" className="truncate font-semibold text-text-primary">{name}</T>
        {title && <T size="xs" className="truncate text-text-secondary">{title}</T>}
        {department && <T size="xs" className="truncate text-text-tertiary">{department}</T>}
      </Stack>
    </Inline>
  );
}

export function PersonRef({
  personId,
  name,
  title,
  department,
  avatarSize = 18,
  showAvatar = true,
  avatarUrl,
  className,
}: {
  personId: string | null;
  name: string | null;
  /** Shown on the card. The table has it for free; the header does not. */
  title?: string | null;
  department?: string | null;
  avatarSize?: number;
  showAvatar?: boolean;
  /** The person's portrait (people.avatar_url); absent/null renders initials. */
  avatarUrl?: string | null;
  className?: string;
}) {
  // Pin/hover state belongs to this actor and person. An old detail request
  // must not survive a tenant, role, sign-in, or displayed-person change.
  const [openedScope, setOpenedScope] = useState<string | null>(null);
  // The graph node a name links to is an orgiq route. In any other tenant the
  // person is a name with a card, not a door into another product — the
  // tenants share a BFF, not journeys.
  const { session, sessionStatus } = useSession();
  const ready = sessionStatus === 'ready';
  const linkable = ready && session?.tenant === 'orgiq';
  const inferred = linkable && session?.role === 'hr-admin';
  const scope = JSON.stringify([sessionStatus, session?.sub, session?.tenant, session?.role,
    session?.masquerading?.actor, session?.masquerading?.asUser, personId]);
  const everOpened = openedScope === scope;

  if (!name) return <T className="text-text-tertiary">—</T>;

  // A name with no id is a name, not a broken link: render it plainly rather
  // than a control that goes nowhere.
  const plain = (
    <Inline gap="xs" align="center" wrap={false} className={className}>
      {showAvatar && <Avatar name={name} size={avatarSize} title={name} src={avatarUrl ?? undefined} />}
      <T className="truncate">{name}</T>
    </Inline>
  );
  if (!personId) return plain;
  // Space has no native action on either trigger, so it pins without scrolling the page.
  const keepSpace = (e: KeyboardEvent) => {
    if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); }
    // The containing table may also use Enter to open a row. This person's
    // link/button owns that key; its native link action still runs.
    if (e.key === 'Enter') e.stopPropagation();
  };
  if (!linkable) {
    return (
      // Other tenants and unavailable identities never request or inherit
      // inferred details. Ready readers may see the same public demo profile.
      <HoverCard key={scope} label={`About ${name}`} openOnFocus={false} data-testid="person-card"
        content={<Stack gap="sm"><PersonIdentity name={name} title={title} department={department} avatarUrl={avatarUrl} />
          {ready && <PublicPersonSummary personId={personId} projectLinks={false} />}</Stack>}>
        {(trigger) => (
          <span {...trigger} tabIndex={0} role="button" aria-label={name} aria-haspopup="dialog"
            onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); keepSpace(e); trigger.onKeyDown(e); }}>
            {plain}
          </span>
        )}
      </HoverCard>
    );
  }

  return (
    // Enter keeps the link's native action (navigate to the graph node); the
    // pin it also toggles is moot once the page changes.
    <HoverCard key={scope} label={`About ${name}`} openOnFocus={false} onOpenChange={(open) => { if (open) setOpenedScope(scope); }} data-testid="person-card"
      content={(
        <Stack gap="xs">
          <PersonIdentity name={name} title={title} department={department} avatarUrl={avatarUrl} />
          {everOpened && (inferred
            ? <InferredHoverDetail key={scope} personId={personId} />
            : <PublicPersonSummary personId={personId} />)}
        </Stack>
      )}>
      {({ 'aria-expanded': _expanded, 'aria-controls': _controls, ...trigger }) => (
        <Link
          {...trigger}
          to={personPath(personId)}
          aria-label={name}
          onKeyDown={(e) => { keepSpace(e); trigger.onKeyDown(e); }}
          className={`inline-flex items-center gap-1.5 no-underline hover:underline ${className ?? 'text-text-secondary'}`}
        >
          {showAvatar && <Avatar name={name} size={avatarSize} title={name} src={avatarUrl ?? undefined} />}
          <T className="truncate">{name}</T>
        </Link>
      )}
    </HoverCard>
  );
}
