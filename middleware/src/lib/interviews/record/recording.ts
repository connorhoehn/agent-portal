// Where an interview's recording is, whether it may be played, and the state of each part of the record (row I5.1,
// contract E2).
//
// Every part is in one of four states, decided in this order:
//   declined   the candidate's stored answer to that part was no (nothing else about the answers is shown);
//   deleted    the deletion log says that kind was removed for this interview (a request or a period);
//   none       there simply is none;
//   available  otherwise.
//
// The recording itself lives in the media stack. The record page lists and plays the interview's recording through
// platform-api with the viewer's own realtime token, and platform-api asks this middleware's `/recording-access`
// (recording-rules.ts, D3) on every list and every play. So this module never returns a URL: `playbackUrl` is always null
// here, no share link is ever minted, and `available` for a real recording means "the candidate agreed and nothing removed
// it; ask the media service". The mock world keeps its seeded stand-ins (mock/interviews-records.ts: a recording row with a
// duration and nothing playable); any other interview there is asked about like anywhere else when a platform-api is
// configured for the browser (the social profile, where calls really record, as a hangout's do), and has none otherwise.
import { config } from '../../../config.js';
import { interviewRecordingsFixture } from '../../../mock/interviews-records.js';
import type { ConsentRecord } from '../consent/store.js';
import type { DeletionRow } from '../retention/store.js';

export type PartState = 'available' | 'none' | 'declined' | 'deleted';

export interface PartFacts {
  /** The candidate's stored answer to this part; null when there is no stored answer. */
  agreed: boolean | null;
  /** The deletion log removed this part for this interview. */
  removed: boolean;
  /** Something of this part exists to show. */
  present: boolean;
}

/** The four states, pure. */
export function partState(f: PartFacts): PartState {
  if (f.agreed === false) return 'declined';
  if (f.removed) return 'deleted';
  return f.present ? 'available' : 'none';
}

/** The kinds the deletion log removed for this interview (any reason). */
export function removedKinds(rows: readonly Pick<DeletionRow, 'interviewIds' | 'removed'>[], interviewId: string): Set<string> {
  return new Set(rows.filter((r) => r.interviewIds.includes(interviewId)).flatMap((r) => r.removed.map((x) => x.kind)));
}

export interface RecordingPart {
  state: PartState;
  /** Always null from this middleware: playback goes through platform-api, which asks /recording-access. */
  playbackUrl: null;
  durationSeconds: number | null;
  /** The mock world's stand-in: a recording row with nothing playable. */
  standIn: boolean;
}

/** The recording's part of the record. */
export function recordingPart(interviewId: string, consent: Pick<ConsentRecord, 'recording'> | null, removed: ReadonlySet<string>,
  mock: boolean = config.mock?.aurora === true, mediaService: boolean = Boolean(config.realtime?.platformApiUrl)): RecordingPart {
  const standIn = mock ? interviewRecordingsFixture.rows().find((r) => r.interviewId === interviewId) ?? null : null;
  // Only the media service knows whether a real recording exists; the candidate's yes is what lets the page ask. A mock world
  // with no platform-api has no media service to ask.
  const present = standIn !== null || ((!mock || mediaService) && consent?.recording === true);
  const state = partState({ agreed: consent ? consent.recording : null, removed: removed.has('recording'), present });
  return {
    state,
    playbackUrl: null,
    durationSeconds: state === 'available' && standIn ? standIn.durationSeconds : null,
    standIn: state === 'available' && standIn !== null,
  };
}
