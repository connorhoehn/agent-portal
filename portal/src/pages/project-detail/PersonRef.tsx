// A person's name, wherever it appears: hoverable, and a real link.
//
// Names were dead text (the work table) or ghost buttons that opened a modal
// (the header) — so the same person behaved differently depending on which
// row you found them in, and neither could be opened in a new tab, copied, or
// linked to. This is the one way a person is rendered on this page: a link to
// their node in the graph, with an Outlook-style people card that answers
// "who is this" on hover without spending a navigation to find out.
//
// The card's own open/close/pin state is a local, non-modal disclosure
// (see PersonCardFrame.tsx and personCardState.ts), not the library's
// PersonHoverCard: that component opens its panel on focus and its
// InlinePopover always moves focus into the panel and traps Tab there the
// moment it opens, which made a table of person chips unusable past row 1 by
// keyboard (docs/orgiq-journeys/sme/DEFECTS.md #2). Here, focus alone never
// opens the card, Enter/Space toggles a pin, Escape closes it without moving
// focus (it was never taken from the trigger), and Tab always continues to
// the next control regardless of whether the card is open or pinned.
//
// The card's detail is fetched ONLY once a hover/pin has actually opened it
// at least once. A table of twenty rows must not fire twenty person requests
// on mount to fill in cards nobody looked at.

import { useCallback, useEffect, useId, useReducer, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { Link } from 'react-router';
import { Avatar, Chip, Inline, LoadingState, Stack } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { PersonCardFrame } from './PersonCardFrame';
import { initialPersonCardState, isPersonCardVisible, personCardReducer } from './personCardState.ts';
import { T } from './Text';
import type { PersonDetail } from './types';

const HOVER_OPEN_DELAY = 450;
const HOVER_CLOSE_DELAY = 250;

/** Where a person's name goes when you click it. */
export function personPath(personId: string): string {
  return `/iq/explore?focus=${encodeURIComponent(personId)}`;
}

function HoverDetail({ personId }: { personId: string }) {
  const { data, error } = useFetch<PersonDetail>(`/api/graph/people/${encodeURIComponent(personId)}`);
  if (error) return <T className="text-[11px] text-text-tertiary">Couldn’t load details.</T>;
  if (!data) return <LoadingState label="Loading…" spinnerSize="sm" />;
  const skills = data.skills.slice(0, 5);
  return (
    <Stack gap="xs">
      {skills.length > 0 && (
        <Inline gap="xs">
          {skills.map((s) => <Chip key={s} size="xs">{s}</Chip>)}
        </Inline>
      )}
      <T className="text-[11px] text-text-tertiary">
        Click the name to open {data.name.split(' ')[0]} in the graph.
      </T>
    </Stack>
  );
}

/** The identity block the card shows immediately, before any fetch. */
function PersonIdentity({ name, title, department }: { name: string; title?: string | null; department?: string | null }) {
  return (
    <Inline gap="xs" align="center">
      <Avatar name={name} size={32} />
      <Stack gap="none">
        <T className="truncate text-sm font-semibold text-text-primary">{name}</T>
        {title && <T className="truncate text-xs text-text-secondary">{title}</T>}
        {department && <T className="truncate text-xs text-text-tertiary">{department}</T>}
      </Stack>
    </Inline>
  );
}

/**
 * Shared hover/pin timing + state for both branches below. Neither branch
 * moves focus anywhere: the trigger keeps focus for its whole lifecycle, so
 * "Escape returns focus to the trigger" is true by construction.
 */
function usePersonCard(anchorRef: RefObject<HTMLElement | null>) {
  const [state, dispatch] = useReducer(personCardReducer, initialPersonCardState);
  const [everOpened, setEverOpened] = useState(false);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);
  useEffect(() => clearTimers, [clearTimers]);

  const scheduleOpen = useCallback(() => {
    clearTimers();
    openTimer.current = setTimeout(() => {
      dispatch({ type: 'hover-open' });
      setEverOpened(true);
    }, HOVER_OPEN_DELAY);
  }, [clearTimers]);

  const scheduleClose = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => dispatch({ type: 'hover-close' }), HOVER_CLOSE_DELAY);
  }, [clearTimers]);

  const togglePin = useCallback(() => {
    clearTimers();
    setEverOpened(true);
    dispatch({ type: 'toggle-pin' });
  }, [clearTimers]);

  const visible = isPersonCardVisible(state);

  // Escape closes whatever is showing. Attached to the trigger itself, so
  // it only fires while the trigger (or its child) has focus — it never
  // reaches for focus, since the trigger already has it.
  const onEscape = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !visible) return;
    e.stopPropagation();
    clearTimers();
    dispatch({ type: 'dismiss' });
    anchorRef.current?.focus();
  }, [visible, clearTimers, anchorRef]);

  return { visible, everOpened, scheduleOpen, scheduleClose, togglePin, clearTimers, onEscape };
}

export function PersonRef({
  personId,
  name,
  title,
  department,
  avatarSize = 18,
  showAvatar = true,
  className,
}: {
  personId: string | null;
  name: string | null;
  /** Shown on the card. The table has it for free; the header does not. */
  title?: string | null;
  department?: string | null;
  avatarSize?: number;
  showAvatar?: boolean;
  className?: string;
}) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const cardId = useId();
  const { visible, everOpened, scheduleOpen, scheduleClose, togglePin, clearTimers, onEscape } = usePersonCard(anchorRef);
  // The graph node a name links to is an orgiq route. In any other tenant the
  // person is a name with a card, not a door into another product — the
  // tenants share a BFF, not journeys.
  const { session } = useSession();
  const linkable = session?.tenant === 'orgiq';

  if (!name) return <T className="text-text-tertiary">—</T>;

  // A name with no id is a name, not a broken link: render it plainly rather
  // than a control that goes nowhere.
  if (!personId || !linkable) {
    const plain = (
      <Inline gap="xs" align="center" wrap={false} className={className}>
        {showAvatar && <Avatar name={name} size={avatarSize} title={name} />}
        <T className="truncate">{name}</T>
      </Inline>
    );
    if (!personId) return plain;
    return (
      <>
        <span
          ref={anchorRef as RefObject<HTMLSpanElement>}
          tabIndex={0}
          role="button"
          aria-haspopup="dialog"
          aria-expanded={visible}
          aria-describedby={visible ? cardId : undefined}
          onMouseEnter={scheduleOpen}
          onMouseLeave={scheduleClose}
          onKeyDown={(e) => {
            // No native action to preserve here (there's no destination),
            // so both keys pin — unlike the linkable branch below.
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePin(); }
            onEscape(e);
          }}
        >
          {plain}
        </span>
        {/* No `details` here: HoverDetail reads the orgiq graph, which
            another tenant's session is (correctly) refused. The card
            carries what the row already knows — name, title, department —
            and nothing fetched. */}
        <PersonCardFrame anchorRef={anchorRef} open={visible} id={cardId} ariaLabel={`About ${name}`} onMouseEnter={clearTimers} onMouseLeave={scheduleClose}>
          <PersonIdentity name={name} title={title} department={department} />
        </PersonCardFrame>
      </>
    );
  }

  return (
    <>
      <Link
        ref={anchorRef as RefObject<HTMLAnchorElement>}
        to={personPath(personId)}
        onMouseEnter={scheduleOpen}
        onMouseLeave={scheduleClose}
        onKeyDown={(e) => {
          // Enter keeps its native action (navigate to the graph node) —
          // overloading it into a pin toggle would swallow the link's own
          // purpose. Space has no native action on a link, so it pins.
          if (e.key === ' ') { e.preventDefault(); togglePin(); }
          onEscape(e);
        }}
        aria-describedby={visible ? cardId : undefined}
        className={`inline-flex items-center gap-1.5 no-underline hover:underline ${className ?? 'text-text-secondary'}`}
      >
        {showAvatar && <Avatar name={name} size={avatarSize} title={name} />}
        <T className="truncate">{name}</T>
      </Link>
      <PersonCardFrame anchorRef={anchorRef} open={visible} id={cardId} ariaLabel={`About ${name}`} onMouseEnter={clearTimers} onMouseLeave={scheduleClose}>
        <Stack gap="xs">
          <PersonIdentity name={name} title={title} department={department} />
          {everOpened && <HoverDetail personId={personId} />}
        </Stack>
      </PersonCardFrame>
    </>
  );
}
