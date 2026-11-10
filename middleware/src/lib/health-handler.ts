import type { Request, Response } from 'express';
import type { HealthProbeSnapshot } from './health-probe.js';
import { judgeSnapshot, type DependencyVerdict, type RuntimeProfile } from './runtime-profile.js';

/** Oldest successful verdict a durable profile accepts while its refresh runs. */
const MAX_AGE_MS = { awsCredentials: 180_000, datastore: 60_000, jobSchema: Number.POSITIVE_INFINITY, messageQueue: 60_000 };

export function createHealthHandler(options: {
  readRealtime: () => { ready?: boolean };
  readAws: () => HealthProbeSnapshot;
  readDatastore: () => HealthProbeSnapshot;
  /** Whether agent_jobs carries the attempt-fencing columns (C7). */
  readJobSchema?: () => HealthProbeSnapshot;
  /** Message-queue readiness; omitted when pipeline queues are in-process. */
  readQueue?: () => HealthProbeSnapshot;
  profile?: RuntimeProfile;
  mocks: Record<string, boolean>;
  region: string;
  /** INSECURE_DEV_MODE is on: reported so nobody mistakes a dev process for a deployment. */
  insecureDevMode?: boolean;
}) {
  const profile = options.profile ?? 'local-ephemeral';
  return (req: Request, res: Response): void => {
    // /health answers before any auth (the load balancer's check). Its
    // diagnostics (profile, mocks, region, probe errors) go only to a loopback
    // caller or a signed-in session; anyone else gets the verdict alone, with
    // the same status code.
    const detailed = healthDetailAllowed(req);
    const send = (code: number, body: Record<string, unknown>) => {
      res.set('Cache-Control', 'no-store');
      res.status(code).json(detailed ? body : { status: body['status'], service: 'orgiq-middleware' });
    };
    const realtime = options.readRealtime();
    const base = { service: 'orgiq-middleware', profile, mocks: options.mocks, region: options.region, realtime,
      ...(options.insecureDevMode ? { insecureDevMode: true } : {}) };
    // A lost router lease is an immediate readiness failure, irrespective of
    // cached database/credential diagnostics or an outstanding refresh.
    if (realtime.ready === false) {
      send(503, { status: 'degraded', ...base });
      return;
    }
    const awsCredentials = options.readAws(), datastore = options.readDatastore();
    const durable = profile === 'durable';
    const capabilities: Record<string, DependencyVerdict> = {};
    const judge = (name: keyof typeof MAX_AGE_MS, snapshot: HealthProbeSnapshot | undefined, missing: string) => {
      const verdict = snapshot ? judgeSnapshot(snapshot, MAX_AGE_MS[name]) : { ok: false, error: missing };
      capabilities[name] = { ...verdict, mandatory: durable };
    };
    judge('awsCredentials', awsCredentials, 'not probed');
    judge('datastore', datastore, 'not probed');
    if (options.readJobSchema || durable)
      judge('jobSchema', options.readJobSchema?.(), 'job-attempt schema is not probed');
    if (options.readQueue || durable)
      judge('messageQueue', options.readQueue?.(), 'pipeline queues are in-process, not durable');
    const unavailable = Object.values(capabilities).some(c => c.mandatory && !c.ok);
    // The local profile keeps its historical verdict: stale or failed
    // diagnostics are degraded, never a 503, so partial stacks keep serving.
    const healthy = durable ? !unavailable && Object.values(capabilities).every(c => c.ok)
      : awsCredentials.ok && !awsCredentials.stale && datastore.ok && !datastore.stale
        && Object.values(capabilities).every(c => c.ok);
    send(unavailable ? 503 : 200, { status: healthy ? 'ok' : 'degraded',
      ...base, awsCredentials, datastore, capabilities });
  };
}

/** 127.0.0.0/8, ::1, or either written as an IPv4-mapped IPv6 address. */
function isLoopbackAddress(raw: string): boolean {
  let a = raw.trim().toLowerCase();
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']') > 0 ? a.indexOf(']') : undefined);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(a)) a = a.slice(0, a.lastIndexOf(':'));
  if (a.startsWith('::ffff:')) a = a.slice('::ffff:'.length);
  if (a === '::1' || a === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

/** Every client address a forwarding hop recorded (X-Forwarded-For, Forwarded `for=`, X-Real-IP). */
function forwardedClients(req: Request): string[] | null {
  const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
  const values = (name: string): string[] => {
    const v = headers[name];
    return v === undefined ? [] : (Array.isArray(v) ? v : [v]);
  };
  const out: string[] = [];
  for (const v of values('x-forwarded-for')) out.push(...v.split(','));
  for (const v of values('x-real-ip')) out.push(v);
  for (const v of values('forwarded')) {
    for (const part of v.split(/[,;]/)) {
      const m = /^\s*for\s*=\s*"?([^";]*)"?\s*$/i.exec(part);
      if (m) out.push(m[1]!);
    }
  }
  const proxied = out.length > 0 || values('via').length > 0 || values('forwarded').length > 0;
  return proxied ? out.map((s) => s.trim()) : null;
}

/**
 * The caller is this host. The socket peer must be loopback, and when a proxy
 * on this host relayed the request (the portal's dev server proxies /api from
 * an address the whole network can reach, and a local sidecar or load
 * balancer would too), every client address it recorded must be loopback as
 * well. A forwarding header can only take loopback away, never grant it: a
 * remote socket is never loopback, whatever its headers say, and the Host
 * header is not read at all.
 */
export function isLoopbackRequest(req: Request): boolean {
  if (!isLoopbackAddress(req.socket?.remoteAddress ?? '')) return false;
  const clients = forwardedClients(req);
  if (clients === null) return true;
  return clients.length > 0 && clients.every(isLoopbackAddress);
}

/** Health diagnostics: a loopback caller, or a signed-in session. */
export function healthDetailAllowed(req: Request): boolean {
  if (isLoopbackRequest(req)) return true;
  const session = (req as Request & { session?: { sub?: string } }).session;
  return typeof session?.sub === 'string' && session.sub.length > 0;
}

/** Process liveness only: no dependency, lease or probe is consulted. */
export function livezHandler(_req: Request, res: Response): void {
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ status: 'alive', service: 'orgiq-middleware', uptimeSeconds: Math.round(process.uptime()) });
}
