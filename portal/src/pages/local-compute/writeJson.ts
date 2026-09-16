// Re-export of the shared helper (src/lib/writeJson.ts). Kept as a file here
// because this folder's consumers are owned by another agent mid-edit — see
// CLAUDE.md's local-compute carve-out. New local-compute code should prefer
// importing '../../lib/writeJson' directly.
export { writeJson, sendJson, HttpError, type WriteResult } from '../../lib/writeJson';
