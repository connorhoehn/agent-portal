// Human-in-the-loop approval routes.
//
// Lifecycle of a single approval:
//   1. Workflow agent (e.g. transaction-ingest) calls `request_approval`
//      Strands tool, which POSTs /approvals/request. We insert into
//      observability.approvals with status=PENDING and broadcast an SSE
//      'approval' event to portal subscribers.
//   2. Portal user (org-leader) clicks Approve/Reject. We Cedar-check
//      OrgIQ::Action::"ApproveTransaction" with resource.amount=payload.amount,
//      write a row to observability.approval_decisions, UPDATE the approvals
//      row, and broadcast an SSE 'decision' event.
//   3. The Strands tool, which has been long-polling GET /approvals/:id every
//      2s, sees the status flip and returns the decision to the agent.
//
// Server-side expiry: GET /approvals/:id flips PENDING rows older than 5min
// to EXPIRED on read so a crashed/forgotten poller can never re-emerge.

import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';
import { config } from '../config.js';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { initSSE, writeSSE, endSSE } from '../lib/sse.js';
import {
  publishApprovalEvent,
  recentApprovalEvents,
  subscribeApprovals,
  type ApprovalCreatedEvent,
  type ApprovalDecisionEvent,
} from '../lib/approval-broker.js';
import { isAllowed } from '../lib/authz.js';
import { logAuthz } from '../lib/audit.js';
import { DEFAULT_ROLE, type Role } from '../lib/session.js';

export const approvalsRouter = Router();

// ── RDS Data API helpers (same shape as providers/aurora.ts) ───────────────

let _client: RDSDataClient | null = null;
function rds(): RDSDataClient {
  if (!_client) _client = new RDSDataClient({ region: config.region });
  return _client;
}

function readField(cell: Field | undefined): unknown {
  if (!cell) return null;
  if (cell.isNull) return null;
  if (cell.stringValue !== undefined) return cell.stringValue;
  if (cell.longValue !== undefined) return cell.longValue;
  if (cell.doubleValue !== undefined) return cell.doubleValue;
  if (cell.booleanValue !== undefined) return cell.booleanValue;
  return null;
}

async function exec(sql: string, params: SqlParameter[] = []): Promise<Record<string, unknown>[]> {
  const resp = await rds().send(
    new ExecuteStatementCommand({
      resourceArn: config.aurora.clusterArn,
      secretArn: config.aurora.secretArn,
      database: config.aurora.database,
      sql,
      parameters: params,
      includeResultMetadata: true,
    }),
  );
  const cols = (resp.columnMetadata ?? []).map((c) => c.name ?? '');
  return (resp.records ?? []).map((record) => {
    const row: Record<string, unknown> = {};
    record.forEach((cell, i) => {
      row[cols[i] ?? `col${i}`] = readField(cell);
    });
    return row;
  });
}

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

function nullableStr(name: string, value: string | null | undefined): SqlParameter {
  if (value === null || value === undefined || value === '') {
    return { name, value: { isNull: true } };
  }
  return { name, value: { stringValue: value } };
}

function jsonParam(name: string, value: unknown): SqlParameter {
  return { name, value: { stringValue: JSON.stringify(value ?? {}) }, typeHint: 'JSON' };
}

// Coerce DB row → typed object the API contract returns.
interface ApprovalRow {
  approvalId: string;
  txId: string;
  agentId: string;
  payload: Record<string, unknown>;
  reason: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decidedNote: string | null;
}

function toApprovalRow(r: Record<string, unknown>): ApprovalRow {
  let payload: Record<string, unknown> = {};
  const raw = r.payload;
  if (typeof raw === 'string') {
    try { payload = JSON.parse(raw) as Record<string, unknown>; } catch { payload = {}; }
  } else if (raw && typeof raw === 'object') {
    payload = raw as Record<string, unknown>;
  }
  return {
    approvalId: String(r.approval_id ?? ''),
    txId: String(r.tx_id ?? ''),
    agentId: String(r.agent_id ?? ''),
    payload,
    reason: r.reason == null ? null : String(r.reason),
    status: String(r.status ?? 'PENDING') as ApprovalRow['status'],
    requestedAt: String(r.requested_at ?? ''),
    decidedAt: r.decided_at == null ? null : String(r.decided_at),
    decidedBy: r.decided_by == null ? null : String(r.decided_by),
    decidedNote: r.decided_note == null ? null : String(r.decided_note),
  };
}

// ── Mock fallback (used when Aurora isn't wired up — keeps local dev usable) ──

const MOCK_ENABLED = !config.aurora.clusterArn || !config.aurora.secretArn || config.mock.aurora;
const mockStore = new Map<string, ApprovalRow>();

function nowIso(): string { return new Date().toISOString(); }

async function insertApproval(row: ApprovalRow): Promise<void> {
  if (MOCK_ENABLED) {
    mockStore.set(row.approvalId, row);
    return;
  }
  await exec(
    `INSERT INTO observability.approvals
       (approval_id, tx_id, agent_id, payload, reason, status, requested_at)
     VALUES
       (CAST(:approval_id AS uuid), :tx_id, :agent_id, CAST(:payload AS jsonb),
        :reason, 'PENDING', now())`,
    [
      strParam('approval_id', row.approvalId),
      strParam('tx_id', row.txId),
      strParam('agent_id', row.agentId),
      jsonParam('payload', row.payload),
      nullableStr('reason', row.reason),
    ],
  );
}

async function fetchApproval(approvalId: string): Promise<ApprovalRow | null> {
  if (MOCK_ENABLED) {
    return mockStore.get(approvalId) ?? null;
  }
  const rows = await exec(
    `SELECT approval_id, tx_id, agent_id, payload, reason, status,
            requested_at, decided_at, decided_by, decided_note
       FROM observability.approvals
      WHERE approval_id = CAST(:id AS uuid)`,
    [strParam('id', approvalId)],
  );
  return rows[0] ? toApprovalRow(rows[0]) : null;
}

async function fetchApprovals(status?: string): Promise<ApprovalRow[]> {
  if (MOCK_ENABLED) {
    const all = Array.from(mockStore.values()).sort((a, b) =>
      b.requestedAt.localeCompare(a.requestedAt),
    );
    return status ? all.filter(r => r.status === status) : all;
  }
  if (status) {
    const rows = await exec(
      `SELECT approval_id, tx_id, agent_id, payload, reason, status,
              requested_at, decided_at, decided_by, decided_note
         FROM observability.approvals
        WHERE status = :status
        ORDER BY requested_at DESC
        LIMIT 200`,
      [strParam('status', status)],
    );
    return rows.map(toApprovalRow);
  }
  const rows = await exec(
    `SELECT approval_id, tx_id, agent_id, payload, reason, status,
            requested_at, decided_at, decided_by, decided_note
       FROM observability.approvals
      ORDER BY requested_at DESC
      LIMIT 200`,
  );
  return rows.map(toApprovalRow);
}

async function applyDecision(
  approvalId: string,
  status: 'APPROVED' | 'REJECTED' | 'EXPIRED',
  decidedBy: string,
  note: string | null,
): Promise<ApprovalRow | null> {
  if (MOCK_ENABLED) {
    const existing = mockStore.get(approvalId);
    if (!existing) return null;
    const updated: ApprovalRow = {
      ...existing,
      status,
      decidedAt: nowIso(),
      decidedBy,
      decidedNote: note,
    };
    mockStore.set(approvalId, updated);
    return updated;
  }

  // Append the immutable decision row first, then update the parent row.
  await exec(
    `INSERT INTO observability.approval_decisions
       (approval_id, status, decided_by, note)
     VALUES
       (CAST(:approval_id AS uuid), :status, :decided_by, :note)`,
    [
      strParam('approval_id', approvalId),
      strParam('status', status),
      strParam('decided_by', decidedBy),
      nullableStr('note', note),
    ],
  );
  const rows = await exec(
    `UPDATE observability.approvals
        SET status = :status,
            decided_at = now(),
            decided_by = :decided_by,
            decided_note = :note
      WHERE approval_id = CAST(:approval_id AS uuid)
      RETURNING approval_id, tx_id, agent_id, payload, reason, status,
                requested_at, decided_at, decided_by, decided_note`,
    [
      strParam('approval_id', approvalId),
      strParam('status', status),
      strParam('decided_by', decidedBy),
      nullableStr('note', note),
    ],
  );
  return rows[0] ? toApprovalRow(rows[0]) : null;
}

// Server-side expiry: PENDING rows older than 5 minutes flip to EXPIRED on read.
// This is the safety net for cases where the agent stops polling (crash, redeploy).
const EXPIRY_MS = 5 * 60 * 1000;

function isPastExpiry(requestedAt: string): boolean {
  const t = Date.parse(requestedAt);
  if (!Number.isFinite(t)) return false;
  return Date.now() - t > EXPIRY_MS;
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Create a new approval request. Called from the agent's `request_approval`
// Strands tool. No auth gate — the agent identity is captured as `agentId`.
approvalsRouter.post('/request', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { txId?: unknown; agentId?: unknown; payload?: unknown; reason?: unknown };
  const txId = typeof body.txId === 'string' ? body.txId : '';
  const agentId = typeof body.agentId === 'string' ? body.agentId : '';
  const payload = (body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload))
    ? (body.payload as Record<string, unknown>)
    : {};
  const reason = typeof body.reason === 'string' ? body.reason : null;
  if (!txId) throw new ValidationError('txId is required');
  if (!agentId) throw new ValidationError('agentId is required');

  const approvalId = randomUUID();
  const row: ApprovalRow = {
    approvalId, txId, agentId, payload, reason,
    status: 'PENDING',
    requestedAt: nowIso(),
    decidedAt: null, decidedBy: null, decidedNote: null,
  };
  await insertApproval(row);

  const ev: ApprovalCreatedEvent = {
    type: 'approval',
    id: approvalId,
    txId,
    agentId,
    payload,
    reason,
    requestedAt: row.requestedAt,
  };
  publishApprovalEvent(ev);

  res.status(201).json({ approvalId });
}));

// List approvals (optionally filtered by status). Used by the portal queue.
approvalsRouter.get('/', asyncHandler(async (req, res) => {
  const status = typeof req.query['status'] === 'string' ? (req.query['status'] as string) : undefined;
  const approvals = await fetchApprovals(status);
  res.json({ approvals });
}));

// SSE stream of approval lifecycle events. Replays the recent buffer on connect.
approvalsRouter.get('/stream', (req, res) => {
  initSSE(res);
  for (const ev of recentApprovalEvents(50).reverse()) {
    writeSSE(res, ev);
  }
  const unsubscribe = subscribeApprovals(ev => writeSSE(res, ev));
  req.on('close', () => { unsubscribe(); endSSE(res); });
});

// Single-row fetch. Used by the Strands tool to long-poll. Server-side: if a
// PENDING row is past its 5min expiry, flip it to EXPIRED before returning so
// stale tools don't hang.
approvalsRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params['id'] as string;
  let row = await fetchApproval(id);
  if (!row) {
    res.status(404).json({ error: 'Approval not found' });
    return;
  }
  if (row.status === 'PENDING' && isPastExpiry(row.requestedAt)) {
    const updated = await applyDecision(id, 'EXPIRED', 'system', 'auto-expired after 5min');
    if (updated) {
      row = updated;
      publishApprovalEvent({
        type: 'decision',
        id,
        status: 'EXPIRED',
        decidedBy: 'system',
        decidedAt: updated.decidedAt ?? nowIso(),
        note: 'auto-expired after 5min',
      });
    }
  }
  res.json(row);
}));

// Submit a decision on an approval. Cedar-gated by ApproveTransaction with
// `resource.amount` populated from the approval's payload so the policy can
// enforce threshold-based authority (e.g. `when { resource.amount > 10000 }`).
approvalsRouter.post('/:id/decision', asyncHandler(async (req, res) => {
  const id = req.params['id'] as string;
  const body = (req.body ?? {}) as { decision?: unknown; note?: unknown };
  const decision = typeof body.decision === 'string' ? body.decision.toUpperCase() : '';
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    throw new ValidationError("decision must be 'APPROVED' or 'REJECTED'");
  }
  const note = typeof body.note === 'string' ? body.note : null;

  const existing = await fetchApproval(id);
  if (!existing) {
    res.status(404).json({ error: 'Approval not found' });
    return;
  }
  if (existing.status !== 'PENDING') {
    res.status(409).json({ error: `Approval already ${existing.status.toLowerCase()}` });
    return;
  }

  // Cedar PEP — pass `resource.amount` from the captured payload so threshold
  // policies on org-leader can fire correctly.
  const session = req.session ?? { sub: 'anon', role: DEFAULT_ROLE, iat: 0 };
  const amountRaw = existing.payload['amount'];
  const amount = typeof amountRaw === 'number'
    ? amountRaw
    : (typeof amountRaw === 'string' ? Number(amountRaw) : NaN);
  const resourceAttrs = Number.isFinite(amount) ? { amount } : {};

  let allowed = false;
  try {
    allowed = await isAllowed(session.role as Role, 'ApproveTransaction', resourceAttrs);
  } catch (err) {
    logAuthz({
      decision: 'DENY',
      action: 'ApproveTransaction',
      sub: session.sub,
      role: session.role,
      path: req.path,
      reason: `authz-error: ${(err as Error).message}`,
    });
    res.status(500).json({ error: 'Authorization check failed' });
    return;
  }
  logAuthz({
    decision: allowed ? 'ALLOW' : 'DENY',
    action: 'ApproveTransaction',
    sub: session.sub,
    role: session.role,
    path: req.path,
    reason: Number.isFinite(amount) ? `amount=${amount}` : undefined,
  });
  if (!allowed) {
    res.status(403).json({ error: 'Forbidden', action: 'ApproveTransaction', role: session.role });
    return;
  }

  const updated = await applyDecision(
    id,
    decision as 'APPROVED' | 'REJECTED',
    session.sub,
    note,
  );
  if (!updated) {
    res.status(500).json({ error: 'Failed to write decision' });
    return;
  }

  const ev: ApprovalDecisionEvent = {
    type: 'decision',
    id,
    status: decision as 'APPROVED' | 'REJECTED',
    decidedBy: session.sub,
    decidedAt: updated.decidedAt ?? nowIso(),
    note,
  };
  publishApprovalEvent(ev);

  res.json(updated);
}));
