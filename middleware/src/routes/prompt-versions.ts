// Prompt versions registry.
//
// The harness runner POSTs each agent's system_prompt at the start of every
// run. We content-address the prompt → short SHA, UPSERT into
// observability.prompt_versions, and return the short SHA. The runner then
// stamps that SHA onto every trace produced by that agent in that run.
//
// Why a registry at all? The trace row records WHICH prompt the agent ran
// against. Without registering content somewhere, the SHA is opaque — you
// can't recover the original prompt text from a 12-char hex digest. The
// registry is the lookup table that closes the loop, so the portal can
// render "prompt v3 of orgiq-search" and let researchers diff prompt
// versions across regressions.
//
// AUTH. The mount comment used to say "ungated"; it has not been for some
// time — index.ts mounts this router behind `viewObs` (tenant + Cedar) and the
// POST carries `ManageCanary` on top. The runner reached it anyway only via
// the dev demo-user fallback, which is off wherever Cognito is configured. It
// now carries the harness runner's own machine identity (`serviceAuthOr` +
// HARNESS_RUNNER_SERVICE_AUTH), applied BOTH here and at the mount, since a
// mount guard runs first. Human callers are unaffected: with the secret unset
// this is exactly the gate it was.

import { Router } from 'express';
import { requireAction } from '../lib/authz.js';
import { HARNESS_RUNNER_SERVICE_AUTH, serviceAuthOr } from '../lib/service-auth.js';
import type { SqlParameter } from '@aws-sdk/client-rds-data';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { exec } from '../providers/aurora.js';
import { config } from '../config.js';
import {
  mockGetPromptVersion,
  mockListPromptVersions,
  mockRegisterPromptVersion,
} from '../mock/prompt-versions.js';
import { shortHash, fullSha256 } from '../lib/pricing.js';

export const promptVersionsRouter = Router();

// ── Types ──────────────────────────────────────────────────────────────────

export interface PromptVersion {
  promptVersion: string;       // short SHA (12 hex chars)
  agentId: string;
  content: string;
  contentSha256: string;       // full SHA-256 for collision verification
  registeredAt: string;
  notes: string | null;
}

// ── Param helpers (same shape as harness.ts) ───────────────────────────────

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

function nullableStr(name: string, value: string | null | undefined): SqlParameter {
  if (value === null || value === undefined) return { name, value: { isNull: true } };
  return { name, value: { stringValue: value } };
}

// ── Row coercion ───────────────────────────────────────────────────────────

function rowToPromptVersion(r: Record<string, unknown>): PromptVersion {
  return {
    promptVersion: String(r['prompt_version'] ?? ''),
    agentId: String(r['agent_id'] ?? ''),
    content: String(r['content'] ?? ''),
    contentSha256: String(r['content_sha256'] ?? ''),
    registeredAt: String(r['registered_at'] ?? ''),
    notes: r['notes'] == null ? null : String(r['notes']),
  };
}

// ── POST /api/observability/prompt-versions ────────────────────────────────
// Register a prompt. Idempotent — if the same content has already been
// registered (same short SHA), we leave the existing row alone and just
// return its promptVersion. The runner calls this once per agent per run.

interface RegisterBody {
  agentId?: string;
  content?: string;
  notes?: string | null;
}

promptVersionsRouter.post('/', serviceAuthOr(HARNESS_RUNNER_SERVICE_AUTH, requireAction('ManageCanary')), asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as RegisterBody;
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : '';
  const content = typeof body.content === 'string' ? body.content : '';
  if (!agentId) throw new ValidationError('agentId is required');
  if (!content) throw new ValidationError('content is required');

  const promptVersion = shortHash(content);
  const contentSha256 = fullSha256(content);

  // The registry is the lookup table behind every prompt-version chip, so a
  // prompt registered offline has to be readable back offline — otherwise the
  // POST succeeds and the GET that follows it 404s.
  if (config.mock.aurora) {
    res.status(201).json({ promptVersion: mockRegisterPromptVersion({ agentId, content, notes: body.notes ?? null }) });
    return;
  }

  // ON CONFLICT DO NOTHING — once a SHA is registered we don't overwrite the
  // canonical text. (If two different contents collided to the same short
  // SHA we'd see content_sha256 mismatch; surface that as a 409 below.)
  await exec(
    `INSERT INTO observability.prompt_versions
       (prompt_version, agent_id, content, content_sha256, registered_at, notes)
     VALUES
       (:prompt_version, :agent_id, :content, :content_sha256, now(), :notes)
     ON CONFLICT (prompt_version) DO NOTHING`,
    [
      strParam('prompt_version', promptVersion),
      strParam('agent_id', agentId),
      strParam('content', content),
      strParam('content_sha256', contentSha256),
      nullableStr('notes', body.notes ?? null),
    ],
  );

  // Sanity check the row we just ensured: if the existing row's full SHA
  // doesn't match what we just hashed, we have a short-SHA collision —
  // surface it as 409 so the caller can rotate to a longer prefix.
  const verify = await exec(
    `SELECT content_sha256 FROM observability.prompt_versions
      WHERE prompt_version = :pv`,
    [strParam('pv', promptVersion)],
  );
  if (verify.length > 0) {
    const stored = String(verify[0]?.['content_sha256'] ?? '');
    if (stored && stored !== contentSha256) {
      res.status(409).json({
        error: 'prompt_version short-SHA collision',
        promptVersion,
        storedSha256: stored,
        attemptedSha256: contentSha256,
      });
      return;
    }
  }

  res.status(201).json({ promptVersion });
}));

// ── GET /api/observability/prompt-versions ─────────────────────────────────
// List all registered prompts, newest first. Bounded at 200 — the registry
// shouldn't grow much larger than n_agents × n_recent_prompt_revisions.

promptVersionsRouter.get('/', asyncHandler(async (_req, res) => {
  // A raw exec() reaches the RDS Data API whatever config.mock.aurora says, so
  // without this the whole registry 500'd offline.
  if (config.mock.aurora) {
    const versions: PromptVersion[] = mockListPromptVersions(200);
    res.json({ versions });
    return;
  }
  const rows = await exec(
    `SELECT prompt_version, agent_id, content, content_sha256,
            registered_at::text AS registered_at, notes
       FROM observability.prompt_versions
      ORDER BY registered_at DESC
      LIMIT 200`,
    [],
  );
  res.json({ versions: rows.map(rowToPromptVersion) });
}));

// ── GET /api/observability/prompt-versions/:promptVersion ──────────────────
// Lookup one prompt by its short SHA. Used by the portal to render the
// canonical prompt text behind a chip.

promptVersionsRouter.get('/:promptVersion', asyncHandler(async (req, res) => {
  const pv = String(req.params['promptVersion'] ?? '').trim();
  if (!pv) throw new ValidationError('promptVersion is required');
  if (config.mock.aurora) {
    const version: PromptVersion | null = mockGetPromptVersion(pv);
    if (!version) {
      res.status(404).json({ error: 'prompt_version not found' });
      return;
    }
    res.json({ version });
    return;
  }
  const rows = await exec(
    `SELECT prompt_version, agent_id, content, content_sha256,
            registered_at::text AS registered_at, notes
       FROM observability.prompt_versions
      WHERE prompt_version = :pv`,
    [strParam('pv', pv)],
  );
  if (rows.length === 0) {
    res.status(404).json({ error: 'prompt_version not found' });
    return;
  }
  res.json({ version: rowToPromptVersion(rows[0]!) });
}));
