// Presence + follow state both deck pages feed the editor and its shell:
// who else is here, which slide each person is on, follow-mode and one-off
// jumps. Mount <DeckPresenceSource onChange={collab.setPresence} .../> beside
// the editor; spread `shellProps` onto EditorShell and render `followBar`.

import { useMemo, useState, type ReactElement } from 'react';
import { EMPTY_DECK_PRESENCE, FollowModeBar, type DeckPresence } from '@connorhoehnslalom/ui-components/doc-editor';

export function useDeckCollaboration() {
  const [presence, setPresence] = useState<DeckPresence>(EMPTY_DECK_PRESENCE);
  const [selectedSlideId, setSelectedSlideId] = useState<string | null>(null);
  const [followingId, setFollowingId] = useState<string | null>(null);
  const [jump, setJump] = useState<{ slideId: string; key: string } | null>(null);

  return useMemo(() => {
    // Following wins over a one-off jump; its key changes whenever they move.
    const followed = followingId ? presence.viewers.find((viewer) => viewer.id === followingId) : undefined;
    const selectSlideRequest = (followed?.slideId ? { slideId: followed.slideId, key: `follow:${followed.id}:${followed.slideId}` } : null) ?? jump;
    const shellProps = presence.viewers.length > 0 ? {
      participants: presence.viewers,
      onParticipantClick: (id: string) => {
        const viewer = presence.viewers.find((candidate) => candidate.id === id);
        if (viewer?.slideId) {
          setFollowingId(null);
          setJump({ slideId: viewer.slideId, key: `jump:${id}:${Date.now()}` });
        }
      },
      onFollowParticipant: (id: string) => {
        // Starting or stopping Follow must not revive an earlier manual jump.
        setJump(null);
        setFollowingId((current) => (current === id ? null : id));
      },
      followingParticipantId: followed?.id ?? null,
    } : {};
    const followBar: ReactElement | null = followed ? (
      <FollowModeBar
        followingUserId={followed.id}
        participants={presence.participants}
        {...(followed.location ? { location: followed.location } : {})}
        onStopFollow={() => {
          setJump(null);
          setFollowingId(null);
        }}
      />
    ) : null;
    const selectSlide = (slideId: string) => {
      // Manual navigation is a deliberate move, so stop following before
      // asking the editor to select the same slide. This is view state only.
      setFollowingId(null);
      setJump({ slideId, key: `present:${slideId}:${Date.now()}` });
      setSelectedSlideId(slideId);
    };
    return { presence, setPresence, selectedSlideId, setSelectedSlideId, selectSlide, selectSlideRequest, shellProps, followBar };
  }, [presence, selectedSlideId, followingId, jump]);
}
