// Reactions and file uploads for the BFF realtime gateway (parity gaps #2, #9).
//
// Reactions: the library's `reactions()` feature, with a durable store for
// targeted (message) reactions: Redis when the gateway has one, memory
// otherwise. Channel authority is the gateway's own `authorize` hook, which
// strips the `reactions:` prefix, so a reaction is allowed exactly where chat
// is.
//
// Uploads: the library's `fileUploads()` feature drives the socket verbs
// (request-upload / complete / cancel); the bytes ride PUT/GET
// /api/uploads/:id, which the library leaves to the host (realtime-examples:
// src/realtime-fanout/fileupload/upload-routes.ts). Both halves share one
// local-disk blob store and metadata store. Blobs live on local disk, so the
// feature is off in production unless GATEWAY_UPLOAD_DIR names a mounted volume
// (Fargate task storage is ephemeral) or GATEWAY_UPLOADS=on is set explicitly.
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import type { IncomingMessage } from 'node:http';
import { FileBlobStore, type FileUploadMetadataStore, type FileUploadRow, type FileUploadService } from '@connorhoehn/realtime-modules/fileupload';
import type { ReactionStore, StoredReaction } from '@connorhoehn/realtime-modules/reactions';
import { getUser } from '../providers/identity.js';
import { decideLiveChannel, type LiveChannelGuards } from './live-principal.js';
import { config as appConfig } from '../config.js';
import { gatewayReactionsFixture, gatewayUploadsFixture } from '../mock/gateway-attachments.js';

// ── reactions ───────────────────────────────────────────────────────────────

const keyOf = (r: { targetId: string; emoji: string; userId: string }) => JSON.stringify([r.targetId, r.emoji, r.userId]);

export class MemoryReactionStore implements ReactionStore {
  private readonly own: StoredReaction[] = [];
  /** `rows` is the registered fixture under MOCK_AURORA, so a mock reset clears reactions. */
  constructor(private readonly rows: () => StoredReaction[] = () => this.own) {}
  async add(reaction: StoredReaction): Promise<void> {
    const rows = this.rows();
    if (!rows.some((r) => r.channel === reaction.channel && keyOf(r) === keyOf(reaction))) rows.push(reaction);
  }
  async remove(key: { channel: string; targetId: string; emoji: string; userId: string }): Promise<void> {
    const rows = this.rows();
    const at = rows.findIndex((r) => r.channel === key.channel && keyOf(r) === keyOf(key));
    if (at >= 0) rows.splice(at, 1);
  }
  async list(channel: string, limit = 500): Promise<StoredReaction[]> {
    return this.rows().filter((r) => r.channel === channel).slice(-limit);
  }
}

/** Upload metadata over `rows()` (the registered fixture under MOCK_AURORA). */
export class RowsFileUploadMetadataStore implements FileUploadMetadataStore {
  private readonly own: FileUploadRow[] = [];
  constructor(private readonly rows: () => FileUploadRow[] = () => this.own) {}
  /** Landed files shared in one conversation, oldest first (the Files view's source). */
  async listByChannel(channel: string): Promise<FileUploadRow[]> {
    return this.rows().filter((r) => r.channel === channel && (r.status === 'uploaded' || r.status === 'completed')).map((r) => ({ ...r }));
  }
  async create(row: Omit<FileUploadRow, 'createdAt'> & { createdAt?: string }): Promise<void> {
    this.rows().push({ ...row, createdAt: row.createdAt ?? new Date().toISOString() });
  }
  async get(uploadId: string): Promise<FileUploadRow | null> {
    const row = this.rows().find((r) => r.uploadId === uploadId);
    return row ? { ...row } : null;
  }
  async updateStatus(uploadId: string, status: FileUploadRow['status'], patch: { size?: number; contentType?: string } = {}): Promise<void> {
    const row = this.rows().find((r) => r.uploadId === uploadId);
    if (row) Object.assign(row, patch, { status, updatedAt: new Date().toISOString() });
  }
}

interface RedisCommands { command: (...args: (string | number)[]) => Promise<unknown> }
const REACTION_TTL_S = 90 * 24 * 60 * 60;

/** One hash per channel, one field per (target, emoji, user); 90-day sliding expiry like chat. */
export class RedisReactionStore implements ReactionStore {
  constructor(private readonly redis: RedisCommands, private readonly namespace = 'orgiq-gateway') {}
  private key(channel: string): string { return `${this.namespace}:reactions:${channel}`; }
  async add(reaction: StoredReaction): Promise<void> {
    await this.redis.command('HSETNX', this.key(reaction.channel), keyOf(reaction), JSON.stringify(reaction));
    await this.redis.command('EXPIRE', this.key(reaction.channel), REACTION_TTL_S);
  }
  async remove(key: { channel: string; targetId: string; emoji: string; userId: string }): Promise<void> {
    await this.redis.command('HDEL', this.key(key.channel), keyOf(key));
  }
  async list(channel: string, limit = 500): Promise<StoredReaction[]> {
    const values = await this.redis.command('HVALS', this.key(channel));
    if (!Array.isArray(values)) return [];
    const rows: StoredReaction[] = [];
    for (const value of values) {
      try { rows.push(JSON.parse(String(value)) as StoredReaction); } catch { /* skip a corrupt field */ }
    }
    return rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp)).slice(-limit);
  }
}

export function createReactionStore(redis: RedisCommands | null, namespace?: string): ReactionStore {
  return redis ? new RedisReactionStore(redis, namespace)
    : new MemoryReactionStore(appConfig.mock.aurora ? () => gatewayReactionsFixture.rows() : undefined);
}

// ── uploads ─────────────────────────────────────────────────────────────────

export const UPLOAD_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
/** Documents and images people attach to a chat. No HTML, SVG or scripts: the GET serves what the PUT stored. */
const ALLOWED_TYPE = /^(image\/(png|jpe?g|gif|webp|avif)|application\/(pdf|zip|msword|vnd\.openxmlformats-officedocument\.[a-z.]+|vnd\.ms-(excel|powerpoint))|text\/(plain|csv|markdown)|audio\/[a-z0-9.+-]+|video\/(mp4|webm|quicktime))$/i;
const INLINE_TYPE = /^image\/(png|jpe?g|gif|webp|avif)$/i;

export function uploadTypeAllowed(contentType: string): boolean {
  return ALLOWED_TYPE.test(contentType.split(';')[0]!.trim());
}

export interface GatewayUploadConfig { enabled: boolean; dir: string; maxBytes: number }

export function gatewayUploadConfig(env: NodeJS.ProcessEnv = process.env): GatewayUploadConfig {
  const flag = (env['GATEWAY_UPLOADS'] ?? '').trim().toLowerCase();
  const dir = (env['GATEWAY_UPLOAD_DIR'] ?? '').trim();
  const production = env['NODE_ENV'] === 'production';
  const enabled = flag === 'off' || flag === 'false' || flag === '0' ? false
    : flag === 'on' || flag === 'true' || flag === '1' ? true
      : !production || dir !== '';
  const configured = Number(env['GATEWAY_UPLOAD_MAX_BYTES']);
  return {
    enabled,
    dir: dir || path.resolve(process.cwd(), '.data', 'uploads'),
    maxBytes: Number.isSafeInteger(configured) && configured > 0 ? configured : UPLOAD_MAX_BYTES_DEFAULT,
  };
}

export interface GatewayUploadBackend { blobStore: FileBlobStore; metadata: FileUploadMetadataStore & { listByChannel(channel: string): Promise<FileUploadRow[]> }; maxBytes: number }
let backend: GatewayUploadBackend | null = null;
/** One store pair per process: the socket verbs and the HTTP routes must see the same rows. */
export function gatewayUploadBackend(config: GatewayUploadConfig = gatewayUploadConfig()): GatewayUploadBackend {
  backend ??= { blobStore: new FileBlobStore({ baseDir: config.dir }), metadata: appConfig.mock.aurora ? new RowsFileUploadMetadataStore(() => gatewayUploadsFixture.rows()) : new RowsFileUploadMetadataStore(), maxBytes: config.maxBytes };
  return backend;
}
export function resetGatewayUploadBackendForTests(): void { backend = null; }

type Ctx = Record<string, unknown> | null;
export type UploadGuards = LiveChannelGuards;

/**
 * The ONE read rule for a stored file, shared by the download, the list and the
 * conversation's Shared work resolver (lib/work-graph/shared-work.ts): the
 * uploader, or someone who may subscribe to the conversation now and whose
 * history floor (members added later) is older than the file.
 */
export async function mayReadUpload(found: FileUploadRow, ctx: Record<string, unknown>, guards: UploadGuards): Promise<boolean> {
  if (found.uploader === ctx['userId']) return true;
  if (!await decideLiveChannel({ kind: 'subscribe', clientId: 'http', channel: found.channel, ctx }, guards)) return false;
  return fileAfterFloor(found, guards.baseChannel(found.channel), String(ctx['userId'] ?? ''));
}

/** The files of `channel` this principal may download now, oldest first (the list's order before its reverse). */
export async function readableUploads(channel: string, ctx: Record<string, unknown>, guards: UploadGuards, config: GatewayUploadConfig = gatewayUploadConfig()): Promise<FileUploadRow[]> {
  const rows = await gatewayUploadBackend(config).metadata.listByChannel(channel).catch(() => [] as FileUploadRow[]);
  const out: FileUploadRow[] = [];
  for (const found of rows) if (await mayReadUpload(found, ctx, guards)) out.push(found);
  return out;
}

/** Options for the library's `fileUploads()` feature; `authz` is the same channel authority chat uses. */
export function uploadFeatureOptions(getCtx: (clientId: string) => Ctx, guards: UploadGuards, config: GatewayUploadConfig = gatewayUploadConfig()) {
  const be = gatewayUploadBackend(config);
  return {
    blobStore: be.blobStore,
    metadataStore: be.metadata,
    maxBytes: be.maxBytes,
    authz: async (_service: FileUploadService, clientId: string, channel: string): Promise<boolean> =>
      decideLiveChannel({ kind: 'publish', clientId, channel, ctx: getCtx(clientId) }, guards),
  };
}

// ── HTTP: PUT/GET /api/uploads/:id ──────────────────────────────────────────

/** The same ctx the websocket upgrade builds, from the realtime bearer token. */
export type UploadAuthenticator = (token: string) => Promise<Record<string, unknown>>;

export interface UploadListItem { id: string; name: string; size: number; contentType: string; url: string; uploader: string; uploaderName: string; sentAt: string }

/** A member added after a file was shared never sees it (strictly after their history floor). */
async function fileAfterFloor(found: FileUploadRow, base: string, userId: string): Promise<boolean> {
  if (!base.startsWith('social:') && !base.startsWith('orgiq:huddle')) return true;
  const { historyFloor } = await import('../routes/chat-pins.js');
  const floor = await historyFloor(base, userId).catch(() => null);
  if (floor === null) return true;
  const sent = Date.parse(found.createdAt);
  return Number.isFinite(sent) && sent > floor;
}

function bearer(req: Request): string | null {
  return /^Bearer (\S+)$/.exec(req.get('authorization') ?? '')?.[1] ?? null;
}

function fail(res: Response, status: number, code: string, message: string): void {
  res.status(status).set('Cache-Control', 'no-store').json({ error: { code, message } });
}

/** A fresh realtime token minted from the request's signed session cookie, or null. */
export type SessionTokenMinter = (req: Request) => Promise<string | null>;

export function createUploadsRouter(
  authenticate: UploadAuthenticator,
  guards: UploadGuards,
  config: GatewayUploadConfig = gatewayUploadConfig(),
  sessionToken?: SessionTokenMinter,
): Router {
  const router = Router();
  const identify = async (req: Request, res: Response): Promise<Record<string, unknown> | null> => {
    if (!config.enabled) { fail(res, 404, 'UPLOADS_DISABLED', 'File uploads are not enabled'); return null; }
    // The library's upload hooks send the token captured when the socket
    // opened, which expires after 10 minutes and is only swapped on reconnect.
    // A same-origin request also carries the signed session cookie, so an
    // absent or expired bearer falls back to a token minted from that session.
    const token = bearer(req);
    if (token) { try { return await authenticate(token); } catch { /* fall back to the session */ } }
    const minted = sessionToken ? await sessionToken(req).catch(() => null) : null;
    if (!minted) { fail(res, 401, 'UNAUTHENTICATED', token ? 'The realtime token is invalid or expired' : 'A realtime bearer token is required'); return null; }
    try { return await authenticate(minted); } catch { fail(res, 401, 'UNAUTHENTICATED', 'The session could not be authenticated'); return null; }
  };
  const mayRead = (found: FileUploadRow, ctx: Record<string, unknown>) => mayReadUpload(found, ctx, guards);
  const row = async (id: string): Promise<FileUploadRow | null> => gatewayUploadBackend(config).metadata.get(id).catch(() => null);

  router.put('/:uploadId', async (req, res) => {
    const ctx = await identify(req, res); if (!ctx) return;
    const be = gatewayUploadBackend(config);
    const uploadId = req.params['uploadId']!;
    const found = await row(uploadId);
    if (!found) return fail(res, 404, 'UPLOAD_NOT_FOUND', 'No upload was requested for this id');
    if (found.uploader !== ctx['userId']) return fail(res, 403, 'FORBIDDEN', 'This upload belongs to another user');
    // The channel must still admit the uploader now, not only when they asked.
    if (!await decideLiveChannel({ kind: 'publish', clientId: 'http', channel: found.channel, ctx }, guards)) {
      return fail(res, 403, 'FORBIDDEN', 'You can no longer post in this conversation');
    }
    if (found.status === 'cancelled' || found.status === 'failed') return fail(res, 409, 'UPLOAD_TERMINAL', `Upload is ${found.status}`);
    const contentType = (req.get('content-type') ?? 'application/octet-stream').split(';')[0]!.trim().toLowerCase();
    if (!uploadTypeAllowed(contentType)) return fail(res, 415, 'UNSUPPORTED_TYPE', `Files of type ${contentType} cannot be attached`);
    const declared = Number(req.get('content-length'));
    if (Number.isFinite(declared) && declared > be.maxBytes) return fail(res, 413, 'PAYLOAD_TOO_LARGE', `Upload exceeds ${be.maxBytes} bytes`);
    try {
      const size = await be.blobStore.putStream(uploadId, req as unknown as IncomingMessage, be.maxBytes);
      await be.metadata.updateStatus(uploadId, 'uploaded', { size, contentType });
      res.set('Cache-Control', 'no-store').json({ uploadId, size });
    } catch (error) {
      const code = (error as { code?: string }).code;
      await be.metadata.updateStatus(uploadId, 'failed').catch(() => undefined);
      if (code === 'TOO_LARGE') return fail(res, 413, 'PAYLOAD_TOO_LARGE', `Upload exceeds ${be.maxBytes} bytes`);
      if (code === 'BAD_ID') return fail(res, 400, 'BAD_REQUEST', 'Invalid upload id');
      fail(res, 500, 'INTERNAL_ERROR', 'The file could not be stored');
    }
  });

  // GET /api/uploads?channel=<gateway channel> — the conversation's Files view. Same
  // authority as the download: a 403 unless the caller may subscribe to the channel
  // now, 404 for another tenant's channel, and only files the caller could download.
  router.get('/', async (req, res) => {
    const ctx = await identify(req, res); if (!ctx) return;
    const channel = typeof req.query['channel'] === 'string' ? req.query['channel'] : '';
    if (!channel || channel.length > 256) return fail(res, 400, 'BAD_REQUEST', 'channel is required');
    const base = guards.baseChannel(channel);
    const tenants = Array.isArray(ctx['tenants']) ? ctx['tenants'].map(String) : [String(ctx['org'] ?? '')];
    if (!tenants.includes(base.split(':')[0]!)) return fail(res, 404, 'NOT_FOUND', 'No such conversation');
    if (!await decideLiveChannel({ kind: 'subscribe', clientId: 'http', channel, ctx }, guards)) {
      return fail(res, 403, 'FORBIDDEN', 'You cannot read this conversation');
    }
    const rows = await gatewayUploadBackend(config).metadata.listByChannel(channel).catch(() => []);
    const files: UploadListItem[] = [];
    for (const found of rows) {
      if (!await mayRead(found, ctx)) continue;
      const user = await getUser(found.uploader).catch(() => null);
      files.push({ id: found.uploadId, name: found.filename, size: found.size, contentType: found.contentType ?? 'application/octet-stream',
        url: `/api/uploads/${encodeURIComponent(found.uploadId)}`, uploader: found.uploader, uploaderName: user?.displayName ?? found.uploader, sentAt: found.createdAt });
    }
    res.set('Cache-Control', 'private, no-store').json({ files: files.reverse() });
  });

  router.get('/:uploadId', async (req, res) => {
    const ctx = await identify(req, res); if (!ctx) return;
    const be = gatewayUploadBackend(config);
    const found = await row(req.params['uploadId']!);
    if (!found || (found.status !== 'uploaded' && found.status !== 'completed')) return fail(res, 404, 'UPLOAD_NOT_FOUND', 'No such file');
    // The uploader, or anyone who may currently read the conversation it was shared in.
    if (!await mayRead(found, ctx)) return fail(res, 403, 'FORBIDDEN', 'You cannot read this file');
    const stream = be.blobStore.createReadStream(req.params['uploadId']!);
    if (!stream) return fail(res, 404, 'UPLOAD_NOT_FOUND', 'No such file');
    const type = found.contentType && uploadTypeAllowed(found.contentType) ? found.contentType : 'application/octet-stream';
    res.set({
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Content-Disposition': `${INLINE_TYPE.test(type) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(found.filename)}`,
    });
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  return router;
}
