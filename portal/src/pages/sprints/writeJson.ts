// Re-export of the shared helper (src/lib/writeJson.ts) — kept as a file here
// because GrantsPanel.tsx in this folder is owned by another agent and still
// imports from './writeJson'. Every other consumer in this folder imports the
// shared module directly.
export { writeJson, type WriteResult } from '../../lib/writeJson';
