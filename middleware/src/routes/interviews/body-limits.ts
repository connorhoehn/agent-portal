// The interviews routes whose bodies are bigger than the app's 100 KB JSON default (lib/json-body.ts), each with room for its
// own size check to be the one that refuses: the whiteboard's checkpoint (the scene's MAX_BOARD_SCENE_BYTES, plus the wire's
// JSON around it) and the kit (a starting board per question at the kit's boardBytes, plus starters).
import type { LargeJsonRoute } from '../../lib/json-body.js';
import { MAX_BOARD_SCENE_BYTES } from '../../lib/interviews/board/snapshots.js';
import { KIT_LIMITS } from '../../lib/interviews/kit.js';

/** Where the interviews router is mounted: index.ts writes it as a literal (the wire's route table reads the source); a test pins the two together. */
export const INTERVIEWS_MOUNT = '/api/interviews';

const SEGMENT = '[^/]+';
const under = (path: string): RegExp => new RegExp(`^${INTERVIEWS_MOUNT}${path}/?$`);

/** A checkpoint's body: the scene at its cap twice over (the client's JSON is not the stored, compacted scene). */
export const BOARD_SNAPSHOT_BODY_LIMIT = 2 * MAX_BOARD_SCENE_BYTES;
/** A kit's body: eight starting boards at their cap. */
export const KIT_BODY_LIMIT = 8 * KIT_LIMITS.boardBytes;

export const INTERVIEWS_LARGE_JSON: readonly LargeJsonRoute[] = [
  { method: 'POST', path: under(`/interviews/${SEGMENT}/board/snapshots`), limit: BOARD_SNAPSHOT_BODY_LIMIT },
  { method: 'PUT', path: under(`/openings/${SEGMENT}/kit`), limit: KIT_BODY_LIMIT },
];
