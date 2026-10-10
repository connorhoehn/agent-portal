// Aurora liveness probe for /api/health.
//
// Credentials being valid says nothing about the database being there. With a
// live AWS session and a torn-down cluster, /api/health reported "ok" while
// every Aurora-backed route returned a 500 — so the portal's own status line
// said the system was healthy while most of it was unreachable.
//
// That gap matters more than it looks: 41 of the 66 portal files that fetch
// never read the error from their request, so a failed load renders as zeros
// and empty lists. "0 open findings" and "0 workers" are indistinguishable
// from a working, idle system. One honest signal at the top is what stops
// every one of those surfaces quietly lying at once.
//
// Cached like the credential probe: a health poll every few seconds must not
// turn into a Data API call every few seconds.

import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import { createHealthProbe } from './health-probe.js';

const TTL_MS = 15_000;

export interface DatastoreStatus {
  ok: boolean;
  /** Short reason when not ok, safe to show in a UI. */
  error?: string;
}

/** Trim a driver error down to something a status line can carry. */
function summarize(err: unknown): string {
  const raw = (err as { name?: string; message?: string }).message
    ?? (err as { name?: string }).name
    ?? 'unknown error';
  const first = String(raw).split('\n')[0] ?? '';
  if (/DatabaseResumingException|resuming/i.test(first)) return 'Aurora is resuming from idle';
  // Seen verbatim during a teardown: the cluster row survives briefly after
  // its instance is deleted, and the Data API reports the missing instance.
  if (/Cannot find DBInstance/i.test(first)) return 'Aurora has no running instance';
  if (/not found|DatabaseNotFound|DBClusterNotFound/i.test(first)) return 'Aurora cluster not found';
  // Emitted while a cluster is being torn down, and also when Aurora is
  // deployed without enableDataApi — the raw text names an ARN and helps nobody.
  if (/HttpEndpoint is not enabled/i.test(first)) return 'Aurora Data API is not enabled';
  if (/AccessDenied|not authorized/i.test(first)) return 'not authorized for the Data API';
  if (/ExpiredToken|credential/i.test(first)) return 'AWS credentials expired';
  return first.slice(0, 140);
}

const probe = createHealthProbe(TTL_MS, async () => {
  await exec('SELECT 1');
  return { ok: true };
}, summarize);

export async function checkDatastore(): Promise<DatastoreStatus> {
  return config.mock.aurora ? { ok: true } : probe.check();
}

export function readDatastoreStatus() {
  return config.mock.aurora ? { ok: true } : probe.snapshot();
}

/** Test hook — drop the cached verdict. */
export function _resetDatastoreProbe(): void {
  probe.reset();
}
