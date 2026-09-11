// KB Registry admin routes — /api/admin/kb-registry
//
// Mounted in index.ts:
//   import { kbAdminRouter } from './routes/kb-admin.js';
//   app.use('/api/admin/kb-registry', kbAdminRouter);
//
// Endpoints:
//   GET    /                  — list all KBs (optional ?tenant=)
//   POST   /                  — create + kick off async provisioning
//   GET    /:id               — single KB (merged with live Bedrock status)
//   PATCH  /:id               — update name / description
//   DELETE /:id               — kick off async deprovisioning
//   POST   /:id/provision     — (re)provision a PENDING or FAILED KB
//   GET    /:id/status        — SSE: poll provisioning status until ACTIVE/FAILED
//   POST   /:id/sync          — trigger ingestion job
//   GET    /:id/jobs          — list ingestion jobs
//   GET    /:id/docs          — list ingested documents for this KB

import { Router } from 'express';
import {
  BedrockAgentClient,
  GetKnowledgeBaseCommand,
  ListDataSourcesCommand,
  ListIngestionJobsCommand,
} from '@aws-sdk/client-bedrock-agent';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import {
  listKbs,
  getKb,
  getKbBySlug,
  createKbEntry,
  updateKbEntry,
  deleteKbEntry,
  provisionKb,
  deprovisionKb,
  type CreateKbInput,
} from '../providers/kb-registry.js';
import { provisioningBroker, type ProvisioningBrokerEvent } from '../lib/provisioning-broker.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { reconcileKnowledgeBases, adoptKnowledgeBase, syncState } from '../providers/kb-reconcile.js';
import { startIngestionJob, listIngestionJobs } from '../providers/knowledge-base.js';
import express from 'express';
import {
  createUploadLink, listUploadLinks, revokeUploadLink, listLinkFiles,
} from '../providers/upload-links.js';
import { listLandingZoneFiles, uploadToLandingZone } from '../providers/landing-zones.js';

/**
 * Marks a response whose query failed — the wrapper from routes/cost.ts, kept
 * local so each router owns its own copy.
 *
 * Every read below answers 200 with an empty payload rather than failing the
 * page, which is the right call. What it cost was the difference between
 * "nothing happened in this window" and "the query blew up": both rendered as
 * an empty panel. The marker restores it without touching the healthy shape —
 * a quiet window answers exactly as it did before, and only a caught failure
 * carries `degraded` + the first line of the error.
 */
function degraded<T extends object>(body: T, err: unknown): T & { degraded: true; error: string } {
  return { ...body, degraded: true, error: (err as Error).message.split('\n')[0]?.slice(0, 160) ?? 'query failed' };
}

export const kbAdminRouter = Router();

// Lazy singleton Bedrock Agent client
let _agent: BedrockAgentClient | null = null;
function agentClient(): BedrockAgentClient {
  if (!_agent) _agent = new BedrockAgentClient({ region: config.region });
  return _agent;
}

function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

// ─── GET /check ───────────────────────────────────────────────────────────────
// Slug + name availability check for the wizard Step 1 "Next" button.
// Returns { slugAvailable, nameAvailable } without creating anything.
// Must be before GET /:id.

kbAdminRouter.get('/check', asyncHandler(async (req, res) => {
  const slug = typeof req.query['slug'] === 'string' ? req.query['slug'] : '';
  const name = typeof req.query['name'] === 'string' ? req.query['name'] : '';

  const [bySlug, all] = await Promise.all([
    slug ? getKbBySlug(slug) : Promise.resolve(null),
    name ? listKbs() : Promise.resolve([]),
  ]);

  const nameConflict = name
    ? all.find(kb => kb.name.toLowerCase() === name.toLowerCase()) ?? null
    : null;

  res.json({
    slugAvailable: !bySlug,
    nameAvailable: !nameConflict,
    slugConflict: bySlug ? bySlug.name : null,
    nameConflict: nameConflict ? nameConflict.slug : null,
  });
}));

// ─── GET /health ──────────────────────────────────────────────────────────────
// Summary of all KB statuses for the portal dashboard widget.
// Must be registered before GET /:id so it isn't swallowed by the param route.

kbAdminRouter.get('/health', asyncHandler(async (_req, res) => {
  const kbs = await listKbs();

  // Offline: listKbs() already served the mock registry (three rows, one —
  // KBMOCK-GONE — deliberately drifted). Report that drift synthetically
  // instead of constructing a real BedrockAgentClient and making network
  // calls that would hang or fail under fake credentials; the reconcile
  // surface is a demo highlight, so it should show a plausible
  // healthy-with-one-drift picture every time, not a slow timeout.
  if (config.mock.aurora) {
    // The three sync fields are DERIVED, not stated. They were
    // `dataSourceCount: 1`, `lastSyncStatus: 'COMPLETE'` and
    // `new Date(Date.now() - 3 * 3_600_000)` — the same three literals
    // `providers/kb-reconcile.ts::syncState` already had removed for breaking
    // contract rule 1, living on in a second copy here. What the copy cost is
    // specific: this widget claimed "synced 3h ago" while the job list beside it
    // read 6h, no scenario could move it (pin `kb-ingestion-jobs` to `error` and
    // it still said COMPLETE over a FAILED head), and the raw `Date.now()` meant
    // freezing the clock did not freeze it. `syncState` is now shared, so the
    // widget and the reconcile page cannot disagree about the same knowledge
    // base by construction rather than by review.
    const summary = await Promise.all(kbs.map(async (kb) => {
      const gone = kb.bedrockKbId === 'KBMOCK-GONE';
      const sync = kb.bedrockKbId && !gone
        ? (await syncState(kb.bedrockKbId)).items
        : { dataSourceCount: null, lastSyncStatus: null, lastSyncAt: null };
      return {
        id: kb.id,
        slug: kb.slug,
        tenant: kb.tenant,
        status: kb.status,
        reachable: !gone,
        awsStatus: gone ? null : 'ACTIVE',
        dataSourceCount: sync.dataSourceCount,
        lastSyncStatus: sync.lastSyncStatus,
        lastSyncAt: sync.lastSyncAt,
        problem: gone
          ? `knowledge base ${kb.bedrockKbId} no longer exists in AWS — registered here but deleted upstream; agents will fail KB retrieval`
          : null,
      };
    }));
    const broken = summary.filter((s) => s.reachable === false && s.status !== 'PENDING').length;
    const healthy = summary.filter((s) => s.reachable && !s.problem).length;
    const degraded = summary.filter((s) => s.reachable && Boolean(s.problem)).length;
    const pending = summary.filter((s) => s.status === 'PENDING').length;
    res.json({ healthy, degraded, broken, pending, kbs: summary });
    return;
  }

  const client = new BedrockAgentClient({ region: config.region });

  // Health must be a real probe of AWS, not an echo of the registry's own
  // status column. Previously a KB deleted out-of-band still reported ACTIVE
  // with no error — the enrichment call failed and the catch swallowed it, so
  // "missing in AWS" and "healthy, never synced" rendered identically. Agents
  // then failed KB retrieval at run time while this page stayed green.
  const summary = await Promise.all(kbs.map(async (kb) => {
    const base = {
      id: kb.id,
      slug: kb.slug,
      tenant: kb.tenant,
      /** Registry's own lifecycle column. */
      status: kb.status,
      /** True only when Bedrock confirms the knowledge base exists. */
      reachable: false as boolean,
      awsStatus: null as string | null,
      dataSourceCount: null as number | null,
      lastSyncStatus: null as string | null,
      lastSyncAt: null as string | null,
      problem: null as string | null,
    };

    if (!kb.bedrockKbId) {
      base.problem = kb.status === 'PENDING'
        ? 'not provisioned yet — no Bedrock knowledge base has been created'
        : 'registry row has no Bedrock knowledge base id';
      return base;
    }

    try {
      const got = await client.send(new GetKnowledgeBaseCommand({ knowledgeBaseId: kb.bedrockKbId }));
      base.reachable = true;
      base.awsStatus = got.knowledgeBase?.status ?? null;
    } catch (err) {
      const name = (err as { name?: string }).name ?? 'UnknownError';
      base.problem = name === 'ResourceNotFoundException'
        ? `knowledge base ${kb.bedrockKbId} no longer exists in AWS — registered here but deleted upstream; agents will fail KB retrieval`
        : `knowledge base lookup failed (${name})`;
      return base;
    }

    try {
      const ds = await client.send(new ListDataSourcesCommand({ knowledgeBaseId: kb.bedrockKbId }));
      base.dataSourceCount = ds.dataSourceSummaries?.length ?? 0;
      if (base.dataSourceCount === 0) {
        base.problem = 'no data source attached — nothing can be ingested';
      }
    } catch { /* leave null; the KB itself is confirmed reachable */ }

    if (kb.dataSourceId) {
      try {
        const jobs = await client.send(new ListIngestionJobsCommand({
          knowledgeBaseId: kb.bedrockKbId,
          dataSourceId: kb.dataSourceId,
          maxResults: 1,
          sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
        }));
        const latest = jobs.ingestionJobSummaries?.[0];
        base.lastSyncStatus = latest?.status ?? null;
        base.lastSyncAt = latest?.startedAt ? new Date(latest.startedAt).toISOString() : null;
        if (!latest && !base.problem) base.problem = 'never synced — documents are not searchable yet';
      } catch (err) {
        const name = (err as { name?: string }).name ?? 'UnknownError';
        if (!base.problem) base.problem = `ingestion history unavailable (${name})`;
      }
    }

    return base;
  }));

  // Counts reflect the PROBE, not the registry column: a KB the registry calls
  // ACTIVE but AWS cannot find is broken, and must be counted as such.
  const broken   = summary.filter(s => s.reachable === false && s.status !== 'PENDING').length;
  const healthy  = summary.filter(s => s.reachable && !s.problem).length;
  const degraded = summary.filter(s => s.reachable && Boolean(s.problem)).length;
  const pending  = summary.filter(s => s.status === 'PENDING').length;

  res.json({ healthy, degraded, broken, pending, kbs: summary });
}));

// ─── GET / ────────────────────────────────────────────────────────────────────

kbAdminRouter.get('/', asyncHandler(async (req, res) => {
  // Tenant scope comes from the session, never the client. The cross-tenant
  // admin role may pass ?tenant= to inspect a specific tenant (or omit it for all).
  const session = req.session;
  const requested = typeof req.query['tenant'] === 'string' ? req.query['tenant'] : undefined;
  const tenant = session?.role === 'admin' ? requested : session?.tenant;
  const kbs = await listKbs(tenant);
  res.json({ kbs });
}));

// ─── POST / ───────────────────────────────────────────────────────────────────

kbAdminRouter.post('/', asyncHandler(async (req, res) => {
  const body = req.body as Partial<CreateKbInput>;

  // Validation
  if (typeof body.name !== 'string' || !body.name.trim()) {
    throw new ValidationError('name must be a non-empty string');
  }
  if (typeof body.slug !== 'string' || !/^[a-z0-9-]+$/.test(body.slug)) {
    throw new ValidationError('slug must match /^[a-z0-9-]+$/');
  }
  if (typeof body.tenant !== 'string' || !body.tenant.trim()) {
    throw new ValidationError('tenant must be a non-empty string');
  }
  if (typeof body.purpose !== 'string' || !body.purpose.trim()) {
    throw new ValidationError('purpose must be a non-empty string');
  }
  if (typeof body.s3Prefix !== 'string' || !body.s3Prefix.trim()) {
    throw new ValidationError('s3Prefix must be a non-empty string');
  }

  const input: CreateKbInput = {
    name: body.name.trim(),
    slug: body.slug,
    tenant: body.tenant.trim(),
    purpose: body.purpose.trim(),
    description: typeof body.description === 'string' ? body.description : undefined,
    s3Prefix: body.s3Prefix.trim(),
    chunkingStrategy: typeof body.chunkingStrategy === 'string' ? body.chunkingStrategy : undefined,
    maxTokens: typeof body.maxTokens === 'number' ? body.maxTokens : undefined,
  };

  // Slug / name uniqueness pre-check — returns 409 with a readable message
  // instead of letting the DB unique constraint surface as a generic 500.
  const [slugConflict, nameConflict] = await Promise.all([
    getKbBySlug(input.slug),
    listKbs().then(all => all.find(kb => kb.name.toLowerCase() === input.name.toLowerCase())),
  ]);
  if (slugConflict) {
    res.status(409).json({ error: `Slug "${input.slug}" is already used by knowledge base "${slugConflict.name}". Choose a different slug.` });
    return;
  }
  if (nameConflict) {
    res.status(409).json({ error: `Name "${input.name}" is already taken. Choose a different name.` });
    return;
  }

  const entry = await createKbEntry(input);

  // Fire-and-forget provisioning — do NOT await
  provisionKb(entry.id).catch((err: unknown) => {
    console.error(`[kb-admin] background provisionKb failed for ${entry.id}:`, (err as Error).message);
  });

  res.status(201).json({ kb: entry });
}));

// ─── GET /:id ─────────────────────────────────────────────────────────────────

// ── GET /reconcile — registry vs. the live account ──────────────────────────
//
// The registry is bookkeeping about external resources, and nothing kept it
// honest: a seeded row claimed a knowledge base id that had never existed,
// with status ACTIVE, while the knowledge base agents actually query was
// absent. This is the endpoint that makes that visible instead of rendering
// the fiction as fact.
kbAdminRouter.get('/reconcile', asyncHandler(async (_req, res) => {
  res.json(await reconcileKnowledgeBases());
}));

// ── POST /reconcile/adopt — repoint a row at a knowledge base that exists ───
kbAdminRouter.post('/reconcile/adopt', asyncHandler(async (req, res) => {
  const { slug, kbId } = (req.body ?? {}) as { slug?: string; kbId?: string };
  if (!slug || !kbId) throw new ValidationError('slug and kbId are required');
  const out = await adoptKnowledgeBase(slug, kbId);
  if (!out.ok) { res.status(502).json({ error: out.error }); return; }
  res.json(out);
}));

// ── Upload links — let someone add documents without giving them access ─────
//
// These sit above /:id so "upload-links" is not read as a knowledge-base id.

kbAdminRouter.get('/upload-links', asyncHandler(async (req, res) => {
  const kbSlug = req.query['kbSlug'] ? String(req.query['kbSlug']) : undefined;
  res.json({ links: await listUploadLinks(kbSlug) });
}));

kbAdminRouter.post('/upload-links', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as {
    kbSlug?: string; label?: string; expiresInHours?: number; maxFiles?: number; maxBytes?: number;
  };
  if (!body.kbSlug) throw new ValidationError('kbSlug is required');
  if (!body.label?.trim()) {
    // Refused rather than defaulted: an unlabelled link is untraceable the
    // moment you have more than one, which is exactly when you need to know
    // which one let something in.
    throw new ValidationError('label is required — name who this link is for');
  }

  const kb = await getKbBySlug(body.kbSlug);
  if (!kb) throw new NotFoundError(`No knowledge base registered as "${body.kbSlug}"`);

  const created = await createUploadLink({
    kbSlug: body.kbSlug,
    label: body.label.trim(),
    createdBy: req.session?.sub ?? null,
    ...(body.expiresInHours !== undefined && { expiresInHours: Number(body.expiresInHours) }),
    ...(body.maxFiles !== undefined && { maxFiles: Number(body.maxFiles) }),
    ...(body.maxBytes !== undefined && { maxBytes: Number(body.maxBytes) }),
  });

  // The token is returned once and never again — it is not stored, only its
  // hash. Callers that discard this response have to make a new link.
  res.status(201).json(created);
}));

kbAdminRouter.get('/upload-links/:linkId/files', asyncHandler(async (req, res) => {
  res.json({ files: await listLinkFiles(String(req.params['linkId'] ?? '')) });
}));

kbAdminRouter.delete('/upload-links/:linkId', asyncHandler(async (req, res) => {
  const ok = await revokeUploadLink(String(req.params['linkId'] ?? ''));
  if (!ok) throw new NotFoundError('No live upload link with that id');
  res.json({ ok: true });
}));

// ── Landing zone — the authenticated way in ─────────────────────────────────
//
// The portal has had a landing-zone browser calling these two paths for a
// while; they were never implemented, so every upload from it 404'd.

kbAdminRouter.get('/:id/landing-zone/files', asyncHandler(async (req, res) => {
  const entry = await getKb(String(req.params['id'] ?? ''));
  if (!entry) throw new NotFoundError('Knowledge base not found');
  const limit = Math.min(Number(req.query['limit'] ?? 50) || 50, 200);
  const token = req.query['nextToken'] ? String(req.query['nextToken']) : undefined;
  res.json(await listLandingZoneFiles(entry.s3Prefix, {
    limit, ...(token ? { continuationToken: token } : {}),
  }));
}));

kbAdminRouter.post(
  '/:id/landing-zone/upload',
  express.raw({ type: '*/*', limit: '50mb' }),
  asyncHandler(async (req, res) => {
    const entry = await getKb(String(req.params['id'] ?? ''));
    if (!entry) throw new NotFoundError('Knowledge base not found');

    const filename = String(req.query['filename'] ?? '').trim();
    if (!filename) throw new ValidationError('filename query parameter is required');

    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (body.length === 0) throw new ValidationError('Empty file');

    const result = await uploadToLandingZone(
      entry.slug, filename, body, req.get('content-type') ?? 'application/octet-stream',
    );
    res.json({ file: { key: result.key, size: result.size, filename } });
  }),
);

kbAdminRouter.get('/:id', asyncHandler(async (req, res) => {
  const entry = await getKb(String(req.params['id'] ?? ''));
  if (!entry) throw new NotFoundError('Knowledge base not found');

  // If we have a Bedrock KB ID and the DB says ACTIVE/UPDATING, merge live status.
  // Skipped entirely under mock — the fixture's own status is already the
  // "live" answer, and there is no real Bedrock account to ask.
  if (!config.mock.aurora && entry.bedrockKbId && (entry.status === 'ACTIVE' || entry.status === 'UPDATING')) {
    try {
      const resp = await agentClient().send(
        new GetKnowledgeBaseCommand({ knowledgeBaseId: entry.bedrockKbId }),
      );
      const liveStatus = resp.knowledgeBase?.status;
      if (liveStatus) {
        res.json({ kb: { ...entry, status: String(liveStatus) } });
        return;
      }
    } catch (err) {
      // Graceful: Bedrock call failed — return DB row as-is
      console.warn(`[kb-admin] GetKnowledgeBase failed for ${entry.bedrockKbId}:`, (err as Error).message);
    }
  }

  res.json({ kb: entry });
}));

// ─── PATCH /:id ───────────────────────────────────────────────────────────────

kbAdminRouter.patch('/:id', asyncHandler(async (req, res) => {
  const entry = await getKb(String(req.params['id'] ?? ''));
  if (!entry) throw new NotFoundError('Knowledge base not found');

  const body = req.body as { name?: unknown; description?: unknown };
  const patch: { name?: string; description?: string } = {};

  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) {
      throw new ValidationError('name must be a non-empty string');
    }
    patch.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== 'string') {
      throw new ValidationError('description must be a string or null');
    }
    patch.description = typeof body.description === 'string' ? body.description : undefined;
  }

  await updateKbEntry(entry.id, patch);
  res.json({ ok: true });
}));

// ─── DELETE /:id ──────────────────────────────────────────────────────────────

kbAdminRouter.delete('/:id', asyncHandler(async (req, res) => {
  const entry = await getKb(String(req.params['id'] ?? ''));
  if (!entry) throw new NotFoundError('Knowledge base not found');

  // Fire-and-forget deprovisioning — do NOT await
  deprovisionKb(entry.id).catch((err: unknown) => {
    console.error(`[kb-admin] background deprovisionKb failed for ${entry.id}:`, (err as Error).message);
  });

  res.json({ ok: true, message: 'deprovisioning started' });
}));

// ─── POST /:id/provision ─────────────────────────────────────────────────────
// (Re)provision a KB that is in PENDING or FAILED status.
// The normal POST / creates a new row AND provisions it. This endpoint is for:
//   - Seeded rows whose provisioning was deferred
//   - Failed rows that need to be retried after a bug fix

kbAdminRouter.post('/:id/provision', asyncHandler(async (req, res) => {
  const entry = await getKb(String(req.params['id'] ?? ''));
  if (!entry) throw new NotFoundError('Knowledge base not found');

  if (!['PENDING', 'FAILED'].includes(entry.status)) {
    res.status(409).json({
      error: `Cannot provision a KB in status "${entry.status}". Only PENDING and FAILED KBs can be (re)provisioned.`,
    });
    return;
  }

  // Fire-and-forget — client should open the SSE /status stream for live updates
  provisionKb(entry.id).catch((err: unknown) => {
    console.error(`[kb-admin] background provisionKb failed for ${entry.id}:`, (err as Error).message);
  });

  res.status(202).json({ ok: true, message: 'provisioning started', id: entry.id });
}));

// ─── GET /:id/status  [SSE] ───────────────────────────────────────────────────

kbAdminRouter.get('/:id/status', async (req, res) => {
  const id = String(req.params['id'] ?? '');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const POLL_INTERVAL_MS = 4_000;
  const TIMEOUT_MS = 360_000; // 6 minutes

  let finished = false;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const send = (payload: Record<string, unknown>) => {
    if (!finished) res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const finish = () => {
    if (finished) return;
    finished = true;
    provisioningBroker.off(`kb:${id}`, onBrokerEvent);
    if (intervalId !== null) clearInterval(intervalId);
    if (timeoutId !== null) clearTimeout(timeoutId);
    res.end();
  };

  req.on('close', finish);

  // ── Live step events from provisionKb (same process) ─────────────────────
  const onBrokerEvent = (ev: ProvisioningBrokerEvent) => {
    send(ev as unknown as Record<string, unknown>);
    if (ev.type === 'complete' || ev.type === 'failed') finish();
  };
  provisioningBroker.on(`kb:${id}`, onBrokerEvent);

  // ── DB-poll heartbeat: handles reconnects + cross-process deploys ─────────
  const poll = async () => {
    if (finished) return;
    try {
      const entry = await getKb(id);
      if (!entry) {
        send({ type: 'error', message: 'KB registry entry not found' });
        finish();
        return;
      }
      // Emit a lightweight heartbeat so the client knows we're alive
      send({ type: 'poll', status: entry.status, kbId: entry.bedrockKbId ?? undefined });

      if (entry.status === 'ACTIVE') {
        send({ type: 'complete', kbId: entry.bedrockKbId ?? '' });
        finish();
      } else if (entry.status === 'FAILED') {
        send({ type: 'failed', message: entry.errorMessage ?? 'Provisioning failed' });
        finish();
      }
    } catch (err) {
      send({ type: 'error', message: (err as Error).message });
      finish();
    }
  };

  // Initial poll immediately, then heartbeat on interval
  await poll();
  if (!finished) {
    intervalId = setInterval(poll, POLL_INTERVAL_MS);
    timeoutId = setTimeout(() => {
      send({ type: 'error', message: 'Provisioning timed out after 6 minutes' });
      finish();
    }, TIMEOUT_MS);
  }
});

// ─── POST /:id/sync ───────────────────────────────────────────────────────────

kbAdminRouter.post('/:id/sync', asyncHandler(async (req, res) => {
  const entry = await getKb(String(req.params['id'] ?? ''));
  if (!entry) throw new NotFoundError('Knowledge base not found');

  if (!entry.bedrockKbId || !entry.dataSourceId) {
    res.status(400).json({
      ok: false,
      error: 'KB is not yet provisioned — bedrockKbId and dataSourceId are required for sync',
    });
    return;
  }

  const body = req.body as { description?: unknown };
  const description = typeof body.description === 'string'
    ? body.description
    : `Manual sync from portal at ${new Date().toISOString()}`;

  // Delegated to the provider rather than calling StartIngestionJob here, and
  // both halves of that mattered.
  //
  // 1. THIS ROUTE HAD NO MOCK BRANCH. It sent to Bedrock unconditionally, so
  //    under `dev:mock` — where the contract is that no AWS call is made — it
  //    reached the real account with whatever credentials the developer had.
  //    Offline it answered a genuine `AccessDeniedException` from a live STS
  //    role, which means the Knowledge page's primary button, "Sync now", could
  //    not work offline at all and failed in a way that looks like a broken
  //    pipeline rather than an unmocked call. It is not listed in
  //    `mock/core/wire/write-policy.ts`, which is why the floor never caught it.
  //
  // 2. Uncaught, the send() reached `asyncHandler`, which answers an
  //    unrecognised error with a bare 500 "Internal server error" and drops the
  //    message — so a `ConflictException` meaning "the sync is already running"
  //    was the most alarming response the platform can give, about the platform
  //    working.
  //
  // `startIngestionJob` already owns the mock branch, the already-running guard
  // and `classifyStartJobFailure`, so /ingest/start and this button now answer
  // the same condition the same way instead of two hand-rolled Bedrock calls
  // drifting apart.
  const outcome = await startIngestionJob(entry.dataSourceId, description, entry.bedrockKbId);
  if (!outcome.ok) {
    res.status(outcome.status).json({
      ok: false, error: outcome.error, conflict: outcome.conflict,
    });
    return;
  }
  if (!outcome.jobId) {
    res.status(500).json({ ok: false, error: 'StartIngestionJob returned no jobId' });
    return;
  }

  res.json({ ok: true, jobId: outcome.jobId });
}));

// ─── GET /:id/jobs ────────────────────────────────────────────────────────────

kbAdminRouter.get('/:id/jobs', asyncHandler(async (req, res) => {
  const entry = await getKb(String(req.params['id'] ?? ''));
  if (!entry) throw new NotFoundError('Knowledge base not found');

  if (!entry.bedrockKbId || !entry.dataSourceId) {
    res.json({ jobs: [] });
    return;
  }

  const limitRaw = req.query['limit'];
  const limit = limitRaw ? Math.min(Math.max(1, parseInt(String(limitRaw), 10) || 20), 100) : 20;

  // The read half of the same gap as POST /:id/sync, and it hid better.
  //
  // This handler called ListIngestionJobs unconditionally, so offline it
  // reached the real account and Bedrock refused — landing in the catch below,
  // which answers `degraded({ jobs: [] })`. The marking is right and the
  // diagnosis it carries is right, but under dev:mock the page's job history
  // was permanently empty: press "Sync now", get a job id back, and see no job.
  // A sync you can start and cannot observe is indistinguishable from a sync
  // that did nothing, which is exactly the complaint this whole pass is about.
  //
  // Keyed on `agentcore` rather than `aurora` because that is what the
  // provider's own `mockAws()` reads — MOCK_AGENTCORE without MOCK_AURORA must
  // still not call Bedrock. `listIngestionJobs` ignores the entry's kbId under
  // mock (the fixture is keyed on data source alone), which is why this is a
  // branch rather than a full delegation: on the real path the registry entry's
  // `bedrockKbId` is the whole point of a multi-KB registry, and the provider
  // pins `config.knowledgeBase.id` instead.
  if (config.mock.agentcore) {
    res.json({ jobs: await listIngestionJobs(entry.dataSourceId, limit) });
    return;
  }

  try {
    const resp = await agentClient().send(
      new ListIngestionJobsCommand({
        knowledgeBaseId: entry.bedrockKbId,
        dataSourceId: entry.dataSourceId,
        maxResults: limit,
        sortBy: { attribute: 'STARTED_AT', order: 'DESCENDING' },
      }),
    );

    const jobs = (resp.ingestionJobSummaries ?? []).map((j) => {
      const stats = (j.statistics ?? {}) as Record<string, unknown>;
      const startMs = j.startedAt instanceof Date ? j.startedAt.getTime() : 0;
      const endMs = j.updatedAt instanceof Date ? j.updatedAt.getTime() : Date.now();
      return {
        jobId: j.ingestionJobId ?? '',
        dataSourceId: entry.dataSourceId,
        status: String(j.status ?? ''),
        startedAt: j.startedAt instanceof Date ? j.startedAt.toISOString() : new Date().toISOString(),
        updatedAt: j.updatedAt instanceof Date ? j.updatedAt.toISOString() : new Date().toISOString(),
        description: j.description ?? '',
        durationMs: startMs > 0 ? Math.max(0, endMs - startMs) : 0,
        documentsScanned: Number(stats['numberOfDocumentsScanned'] ?? 0),
        documentsIndexed:
          Number(stats['numberOfNewDocumentsIndexed'] ?? 0) +
          Number(stats['numberOfModifiedDocumentsIndexed'] ?? 0),
        documentsFailed: Number(stats['numberOfDocumentsFailed'] ?? 0),
        documentsDeleted: Number(stats['numberOfDocumentsDeleted'] ?? 0),
        // Always present, always empty here: Bedrock's ListIngestionJobs
        // summary carries statistics but no failure reasons — only
        // GetIngestionJob does, which is what the portal's "details" button
        // fetches. Emitted anyway so this path and the mock branch above have
        // the same shape; the portal types the field as required and a key that
        // exists offline but not online is how a mock stops being a contract.
        failureReasons: [] as string[],
      };
    });

    res.json({ jobs });
  } catch (err) {
    console.warn(`[kb-admin] GET /:id/jobs failed:`, (err as Error).message);
    // An unmarked empty list here says "this knowledge base has never
    // synced", which is the opposite diagnosis from "Bedrock refused the
    // listing" — and the operator is on this page precisely to tell them
    // apart.
    res.json(degraded({ jobs: [] }, err));
  }
}));

// ─── GET /:id/docs ────────────────────────────────────────────────────────────

kbAdminRouter.get('/:id/docs', asyncHandler(async (req, res) => {
  const entry = await getKb(String(req.params['id'] ?? ''));
  if (!entry) throw new NotFoundError('Knowledge base not found');

  const limitRaw = req.query['limit'];
  const lim = limitRaw ? Math.min(Math.max(1, parseInt(String(limitRaw), 10) || 50), 500) : 50;

  try {
    const rows = await exec(
      `SELECT id::text, source, source_uri, title, ingested_at::text
         FROM documents
        WHERE kb_registry_slug = :slug
        ORDER BY ingested_at DESC NULLS LAST
        LIMIT :lim`,
      [
        strParam('slug', entry.slug),
        intParam('lim', lim),
      ],
    );

    const documents = rows.map((r) => ({
      id: String(r['id'] ?? ''),
      source: r['source'] == null ? null : String(r['source']),
      sourceUri: r['source_uri'] == null ? null : String(r['source_uri']),
      title: r['title'] == null ? null : String(r['title']),
      ingestedAt: r['ingested_at'] == null ? null : String(r['ingested_at']),
    }));

    res.json({ documents, total: documents.length });
  } catch (err) {
    console.warn(`[kb-admin] GET /:id/docs failed:`, (err as Error).message);
    // Same, with a number attached: `total: 0` over a failed query is an
    // empty knowledge base, which is the symptom being investigated.
    res.json(degraded({ documents: [], total: 0 }, err));
  }
}));
