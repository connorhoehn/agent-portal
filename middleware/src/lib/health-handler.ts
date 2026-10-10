import type { Request, Response } from 'express';
import type { HealthProbeSnapshot } from './health-probe.js';

export function createHealthHandler(options: {
  readRealtime: () => { ready?: boolean };
  readAws: () => HealthProbeSnapshot;
  readDatastore: () => HealthProbeSnapshot;
  mocks: Record<string, boolean>;
  region: string;
}) {
  return (_req: Request, res: Response): void => {
    const realtime = options.readRealtime();
    const base = { service: 'orgiq-middleware', mocks: options.mocks, region: options.region, realtime };
    // A lost router lease is an immediate readiness failure, irrespective of
    // cached database/credential diagnostics or an outstanding refresh.
    if (realtime.ready === false) {
      res.status(503).json({ status: 'degraded', ...base });
      return;
    }
    const awsCredentials = options.readAws(), datastore = options.readDatastore();
    res.status(200).json({ status: awsCredentials.ok && !awsCredentials.stale && datastore.ok && !datastore.stale ? 'ok' : 'degraded',
      ...base, awsCredentials, datastore });
  };
}
