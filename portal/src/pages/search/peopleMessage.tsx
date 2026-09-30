// Search → Message (docs/social-tenant-design.md §4.6, lane E): beside Start
// call, a people selection offers "Message" — a direct message in the social
// tenant with the selected person's linked user. The mechanics mirror
// ../projects/peopleCall.tsx (person → user by GET /api/roster/users, the
// reason on the tooltip when it is off); the rules are searchMessageModel.ts.
//
// Pressing it opens the DM (POST /api/social/dms — grant-gated, so it answers
// an orgiq session holding a social grant) and then crosses into the social
// workspace on that DM's page (enterContext → /social/dms/<lobby>). Without a
// social grant there is nothing to open, so the button is not drawn at all.

import { useState, type ReactNode } from 'react';
import { Button, ChatIcon, Inline } from '@connorhoehnslalom/ui-components/shared';
import { useFetch } from '../../hooks/useFetch';
import { useSession } from '../../lib/auth';
import { writeJson } from '../../lib/writeJson';
import { uniquePeople, type CallPerson, type RosterUser } from '../../lib/conversationCallModel';
import { dmPageHref, messageAvailability } from './searchMessageModel';

export function usePeopleMessage(peopleIn: CallPerson[]): ReactNode {
  const { session, enterContext } = useSession();
  const socialRole = session?.grants?.['social']?.[0] ?? null;
  const people = uniquePeople(peopleIn);
  const personIds = people.map((p) => p.personId).join(',');
  const { data: mapping } = useFetch<{ users: RosterUser[]; unlinked: string[] }>(
    socialRole && personIds ? `/api/roster/users?personIds=${encodeURIComponent(personIds)}` : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!socialRole || people.length === 0) return null;
  const availability = messageAvailability({ people, users: mapping?.users ?? null, selfUserId: session?.sub ?? null });

  const open = async () => {
    if (!availability.ok) return;
    setBusy(true);
    setError(null);
    const res = await writeJson<{ channel: string }>('/api/social/dms', 'POST', { userId: availability.target.userId });
    if (!res.ok || !res.data?.channel) {
      setBusy(false);
      setError(res.error ?? 'The conversation could not be opened.');
      return;
    }
    // The server's lobby is the one to open; the library's name agrees (tested).
    await enterContext('social', socialRole, dmPageHref(res.data.channel)).catch((cause: unknown) => {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : 'Could not switch to Social.');
    });
  };

  return (
    <Button
      size="sm"
      variant="ghost"
      // The dock row's family: 28px, 12px/500, transparent — as Start call.
      className="h-7 text-[12px] font-medium"
      data-testid="search-message"
      disabled={!availability.ok || busy}
      title={error ?? availability.reason}
      onClick={() => { void open(); }}
    >
      <Inline gap="xs" align="center">
        <ChatIcon size={14} aria-hidden="true" />
        Message
      </Inline>
    </Button>
  );
}
