// One tile per person when a media participant id holds a colon (an interview's candidate: `guest:<invite>-<stamp>`).
//
// realtime-modules (0.149) keys each remote media participant by its BASE pid, `fullPid.split(':')[0]`, so the screen
// producer `<pid>:screen` folds into its camera. A pid that itself holds a colon is cut short: the candidate's media
// arrives as pid `guest`, with no name and no app user id, so the call shows a "guest" video tile beside the roster's
// "Candidate" tile with no video (and counts one person twice). Until the library keys by the full pid, the call's
// participants are joined here: a media tile no one was matched to, whose pid is the part before the colon of a roster
// person's own media id, IS that person (their name and state, its stream). Anything else is left as it is.

/** The fields of a call participant this join reads and writes (realtime-modules `ConversationCallParticipant`). */
export interface TileLike {
  id: string;
  userId: string;
  isLocal?: boolean;
  state?: string;
  participantId?: string | null;
  stream?: unknown;
  screenStream?: unknown;
}

/** The pid the library would cut this person's media id to: from their media id, or (none known yet) from their user id. */
function cutShortOf(p: TileLike): string | null {
  const own = typeof p.participantId === 'string' && p.participantId ? p.participantId : p.userId;
  return own.includes(':') ? own.split(':')[0]! : null;
}

/** The participants with each cut-short media tile joined to its person; the same array when nothing was joined. */
export function mergeCutShortTiles<P extends TileLike>(participants: readonly P[]): readonly P[] {
  const media = participants.filter((p) => !p.isLocal && !!p.stream && p.userId === p.participantId && !String(p.participantId).includes(':'));
  if (!media.length) return participants;
  const joined = new Map<P, P>();
  const used = new Set<P>();
  for (const m of media) {
    const owners = participants.filter((p) => !p.isLocal && p !== m && !p.stream && !used.has(p)
      && cutShortOf(p) === m.participantId);
    if (owners.length !== 1) continue; // none, or two people it could be: leave it
    const person = owners[0]!;
    used.add(person);
    joined.set(m, { ...m, ...person, id: m.id, participantId: person.participantId ?? m.participantId, stream: m.stream, screenStream: m.screenStream ?? person.screenStream ?? null,
      ...(('cameraOn' in m) ? { cameraOn: (m as { cameraOn?: boolean }).cameraOn } : {}) });
  }
  if (!joined.size) return participants;
  return participants.filter((p) => !used.has(p)).map((p) => joined.get(p) ?? p);
}

/** Who is in the call, counted as the library counts it (in the call, or reconnecting). */
export const inCallCount = (participants: readonly TileLike[]): number =>
  participants.filter((p) => p.state === 'in-call' || p.state === 'reconnecting').length;
