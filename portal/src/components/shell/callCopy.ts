// The word the shell's call chat uses for the call: an interview's is a "call" (the room is not a huddle), every other
// lobby's stays a "huddle". The app's copy, not the library's.
import { isInterviewLobby } from '../../lib/interviewsRoom';

export function callNoun(lobbyName: string | null | undefined): 'huddle' | 'call' {
  return isInterviewLobby(lobbyName) ? 'call' : 'huddle';
}
