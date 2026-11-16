// INTERVIEWS_ENABLED — the interviews tenant's server flag (docs/interviews-tenant-plan.md, decision 1).
//
// `true`/`1` turns it on and `false`/`0` off. Unset, it follows the world: on
// under the mock providers (MOCK_AURORA: dev:mock, the journeys), off on a
// cluster, where the tables in schema/interviews_schema.sql must be applied
// first. Off, every /api/interviews route answers 404 (index.ts mount), the
// way the meeting assistant's routes do with its flag off. Read per request,
// so a test can switch it.
import { config } from '../../config.js';

export function interviewsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = String(env['INTERVIEWS_ENABLED'] ?? '').trim().toLowerCase();
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return config.mock?.aurora === true;
}
