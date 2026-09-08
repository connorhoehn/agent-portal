// Compute nodes — the durable half of local-compute presence.
//
// A NODE is a developer's own machine, paired once against their identity.
// The pairing flow exists because the session cookie cannot leave the
// browser: the portal (an authenticated session holding ConnectLocalCompute)
// mints a short-lived single-use code, the machine's plugin claims it, and
// the claim creates the node and returns its token exactly once. From then on
// the machine authenticates presence writes by presenting the token; only
// sha256(token) is ever stored.
//
// Ownership is bound at pairing from the minting SESSION's sub — the same
// rule as devbox boxes and bot_runs.dispatched_by, for the same reason: an
// attribution a caller can set is not an attribution.
//
// Schema: schema/local_compute_schema.sql. Live sessions on a node are NOT
// here — they are presence, held in lib/local-compute-fleet.ts.

import { createHash, randomBytes } from 'node:crypto';
import { exec } from './aurora.js';
import { config } from '../config.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

function s(name: string, value: string): SqlParameter { return { name, value: { stringValue: value } }; }
function b(name: string, value: boolean): SqlParameter { return { name, value: { booleanValue: value } }; }
function toStr(v: unknown, f = ''): string { return typeof v === 'string' ? v : v == null ? f : String(v); }

export interface ComputeNode {
  id: string;
  ownerId: string;
  label: string;
  platform: string | null;
  acceptJobs: boolean;
  localModels: string[];
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

/** What a successful claim hands the machine — the only time the token exists
 *  in plaintext outside the machine's own keychain. */
export interface ClaimedNode {
  nodeId: string;
  nodeToken: string;
}

const PAIRING_TTL_MS = 10 * 60_000;
const TOKEN_PREFIX = 'lcn_';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function rowToNode(r: Record<string, unknown>): ComputeNode {
  let models: string[] = [];
  try {
    const parsed: unknown = JSON.parse(toStr(r['local_models'], '[]'));
    if (Array.isArray(parsed)) models = parsed.filter((m): m is string => typeof m === 'string');
  } catch { /* malformed models column reads as none */ }
  return {
    id: toStr(r['id']),
    ownerId: toStr(r['owner_id']),
    label: toStr(r['label']),
    platform: r['platform'] ? toStr(r['platform']) : null,
    acceptJobs: r['accept_jobs'] === true,
    localModels: models,
    createdAt: toStr(r['created_at']),
    lastSeenAt: r['last_seen_at'] ? toStr(r['last_seen_at']) : null,
    revokedAt: r['revoked_at'] ? toStr(r['revoked_at']) : null,
  };
}

// ─── Mock fallback (dev:mock / MOCK_AURORA) ──────────────────────────────────
// One pre-paired fixture node owned by the dev demo identity, so the presence
// badge and the pairing-free announce path are exercisable offline. Its token
// is a fixed dev-only string — meaningless outside mock mode, where every
// token is random and unstored.

export const MOCK_NODE_TOKEN = `${TOKEN_PREFIX}mock-local-node-token`;

const mockNodes = new Map<string, ComputeNode>();
const mockTokenIndex = new Map<string, string>(); // token_hash → nodeId
const mockCodes = new Map<string, { ownerId: string; expiresAt: number; claimedAt: number | null }>();

function seedMockNode(): void {
  if (mockNodes.size > 0) return;
  const node: ComputeNode = {
    id: 'node-demo-macbook',
    ownerId: 'demo-user',
    label: 'demo-macbook',
    platform: 'darwin/arm64',
    acceptJobs: false,
    localModels: ['qwen2.5-coder:14b'],
    createdAt: new Date().toISOString(),
    lastSeenAt: null,
    revokedAt: null,
  };
  mockNodes.set(node.id, node);
  mockTokenIndex.set(hashToken(MOCK_NODE_TOKEN), node.id);
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

export async function createPairingCode(ownerId: string): Promise<PairingCode> {
  // 8 chars from an unambiguous alphabet — read off a screen, typed once.
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const code = Array.from(randomBytes(8), (byte) => alphabet[byte % alphabet.length]).join('');
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS).toISOString();
  if (config.mock.aurora) {
    seedMockNode();
    mockCodes.set(code, { ownerId, expiresAt: Date.now() + PAIRING_TTL_MS, claimedAt: null });
    return { code, expiresAt };
  }
  await exec(
    `INSERT INTO compute_pairing_codes (code, owner_id, expires_at)
     VALUES (:code, :owner, :expires::timestamptz)`,
    [s('code', code), s('owner', ownerId), s('expires', expiresAt)],
  );
  return { code, expiresAt };
}

/**
 * Claim a pairing code: single-use, atomically — the UPDATE stamps
 * claimed_at only where it is still NULL and unexpired, so two racing claims
 * cannot both mint a node from one code.
 */
export async function claimPairingCode(
  code: string,
  node: { nodeId?: string; label: string; platform?: string },
): Promise<ClaimedNode | null> {
  const token = TOKEN_PREFIX + randomBytes(24).toString('hex');
  const tokenHash = hashToken(token);
  const nodeId = node.nodeId?.trim() || `node-${randomBytes(6).toString('hex')}`;

  if (config.mock.aurora) {
    seedMockNode();
    const pending = mockCodes.get(code.toUpperCase());
    if (!pending || pending.claimedAt !== null || pending.expiresAt < Date.now()) return null;
    pending.claimedAt = Date.now();
    const created: ComputeNode = {
      id: nodeId, ownerId: pending.ownerId, label: node.label, platform: node.platform ?? null,
      acceptJobs: false, localModels: [], createdAt: new Date().toISOString(),
      lastSeenAt: null, revokedAt: null,
    };
    mockNodes.set(nodeId, created);
    mockTokenIndex.set(tokenHash, nodeId);
    return { nodeId, nodeToken: token };
  }

  const claimed = await exec(
    `UPDATE compute_pairing_codes
        SET claimed_at = NOW()
      WHERE code = :code AND claimed_at IS NULL AND expires_at > NOW()
      RETURNING owner_id`,
    [s('code', code.toUpperCase())],
  );
  const ownerId = claimed[0] ? toStr(claimed[0]['owner_id']) : null;
  if (!ownerId) return null;

  await exec(
    `INSERT INTO compute_nodes (id, owner_id, label, platform, token_hash)
     VALUES (:id, :owner, :label, :platform, :hash)
     ON CONFLICT (id) DO UPDATE
       SET label = EXCLUDED.label, platform = EXCLUDED.platform,
           token_hash = EXCLUDED.token_hash, revoked_at = NULL`,
    [
      s('id', nodeId), s('owner', ownerId), s('label', node.label),
      s('platform', node.platform ?? ''), s('hash', tokenHash),
    ],
  );
  return { nodeId, nodeToken: token };
}

// ─── Token auth + reads ──────────────────────────────────────────────────────

/** Resolve a presented token to its live (unrevoked) node, or null. The
 *  lookup is by sha256 — the plaintext token exists only in the request. */
export async function getNodeByToken(token: string): Promise<ComputeNode | null> {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const tokenHash = hashToken(token);
  if (config.mock.aurora) {
    seedMockNode();
    const id = mockTokenIndex.get(tokenHash);
    const node = id ? mockNodes.get(id) : null;
    return node && !node.revokedAt ? node : null;
  }
  const rows = await exec(
    `SELECT * FROM compute_nodes WHERE token_hash = :hash AND revoked_at IS NULL`,
    [s('hash', tokenHash)],
  );
  return rows[0] ? rowToNode(rows[0]) : null;
}

export async function listNodesByOwner(ownerId: string): Promise<ComputeNode[]> {
  if (config.mock.aurora) {
    seedMockNode();
    return [...mockNodes.values()].filter((n) => n.ownerId === ownerId && !n.revokedAt);
  }
  const rows = await exec(
    `SELECT * FROM compute_nodes
      WHERE owner_id = :owner AND revoked_at IS NULL
      ORDER BY created_at`,
    [s('owner', ownerId)],
  );
  return rows.map(rowToNode);
}

/** Every live node, for fleet-wide operational visibility — the route pairs
 *  this with a session-count summary, never the session detail. */
export async function listAllNodes(): Promise<ComputeNode[]> {
  if (config.mock.aurora) {
    seedMockNode();
    return [...mockNodes.values()].filter((n) => !n.revokedAt);
  }
  const rows = await exec(
    `SELECT * FROM compute_nodes WHERE revoked_at IS NULL ORDER BY created_at LIMIT 200`,
  );
  return rows.map(rowToNode);
}

export async function getNode(id: string): Promise<ComputeNode | null> {
  if (config.mock.aurora) {
    seedMockNode();
    return mockNodes.get(id) ?? null;
  }
  const rows = await exec(`SELECT * FROM compute_nodes WHERE id = :id`, [s('id', id)]);
  return rows[0] ? rowToNode(rows[0]) : null;
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export async function touchNode(id: string): Promise<void> {
  if (config.mock.aurora) {
    const node = mockNodes.get(id);
    if (node) node.lastSeenAt = new Date().toISOString();
    return;
  }
  await exec(`UPDATE compute_nodes SET last_seen_at = NOW() WHERE id = :id`, [s('id', id)]);
}

export async function renameNode(id: string, ownerId: string, label: string): Promise<ComputeNode | null> {
  if (config.mock.aurora) {
    const node = mockNodes.get(id);
    if (!node || node.ownerId !== ownerId) return null;
    node.label = label;
    return node;
  }
  const rows = await exec(
    `UPDATE compute_nodes SET label = :label
      WHERE id = :id AND owner_id = :owner RETURNING *`,
    [s('id', id), s('owner', ownerId), s('label', label)],
  );
  return rows[0] ? rowToNode(rows[0]) : null;
}

export async function setAcceptJobs(id: string, ownerId: string, acceptJobs: boolean): Promise<ComputeNode | null> {
  if (config.mock.aurora) {
    const node = mockNodes.get(id);
    if (!node || node.ownerId !== ownerId) return null;
    node.acceptJobs = acceptJobs;
    return node;
  }
  const rows = await exec(
    `UPDATE compute_nodes SET accept_jobs = :accept
      WHERE id = :id AND owner_id = :owner RETURNING *`,
    [s('id', id), s('owner', ownerId), b('accept', acceptJobs)],
  );
  return rows[0] ? rowToNode(rows[0]) : null;
}

/** Soft revoke: the token stops authenticating immediately; the row stays for
 *  audit. Re-pairing the same machine mints a fresh token and clears it. */
export async function revokeNode(id: string, ownerId: string): Promise<boolean> {
  if (config.mock.aurora) {
    const node = mockNodes.get(id);
    if (!node || node.ownerId !== ownerId) return false;
    node.revokedAt = new Date().toISOString();
    return true;
  }
  const rows = await exec(
    `UPDATE compute_nodes SET revoked_at = NOW()
      WHERE id = :id AND owner_id = :owner AND revoked_at IS NULL RETURNING id`,
    [s('id', id), s('owner', ownerId)],
  );
  return rows.length > 0;
}

/** Test hook — wipe mock state. */
export function _resetLocalComputeMocks(): void {
  mockNodes.clear();
  mockTokenIndex.clear();
  mockCodes.clear();
}
