// An interview call as Milo's policy and tools see it: its lobby `interviews:interview:<interviewId>`, in the lobby family
// `interviews:interview` (milo-policy.ts registers the policy, family.ts the tools).

export const INTERVIEW_FAMILY = 'interviews:interview';

const LOBBY = /^interviews:interview:([^:]+)$/;
/** The interview a lobby names, or null when it names none. */
export const interviewOfLobby = (lobby: string | null | undefined): string | null => LOBBY.exec(lobby ?? '')?.[1] ?? null;
/** The lobby of an interview's call. */
export const lobbyOfInterview = (interviewId: string): string => `${INTERVIEW_FAMILY}:${interviewId}`;
