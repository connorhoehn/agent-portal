// Connected sources — /api/connections
//
// Credentials for the systems an org's knowledge actually lives in. Gated the
// same way ingestion is, because connecting a source is an ingestion decision:
// it determines what ends up in the knowledge base and what agents will cite.
//
// The one rule this router keeps is that a secret travels in one direction.
// It can be written to the vault and it can be used, but there is no endpoint
// that returns one — not redacted, not partially. A credential you can read
// back over HTTP is a credential that leaks over HTTP.

import { Router } from 'express';
import { asyncHandler, ValidationError, NotFoundError } from '../lib/async-handler.js';
import {
  listConnectedSources, connectApiKeySource, disconnectSource, borrowApiKey,
  type SourceKind,
} from '../providers/connected-sources.js';
import { identify, listOrgs, listRepos, readRepoSignal } from '../lib/github-connector.js';

export const connectionsRouter: Router = Router();

const KINDS = new Set<SourceKind>(['github', 'confluence', 'jira']);

connectionsRouter.get('/', asyncHandler(async (_req, res) => {
  res.json({ sources: await listConnectedSources() });
}));

// ── POST / — store a credential ─────────────────────────────────────────────

connectionsRouter.post('/', asyncHandler(async (req, res) => {
  const body = (req.body ?? {}) as { kind?: string; label?: string; apiKey?: string };
  const kind = body.kind as SourceKind | undefined;
  if (!kind || !KINDS.has(kind)) {
    throw new ValidationError(`kind must be one of: ${[...KINDS].join(', ')}`);
  }
  if (!body.label?.trim()) {
    // Named for the same reason upload links are: with more than one, an
    // unlabelled credential cannot be reasoned about or safely revoked.
    throw new ValidationError('label is required — name the account or org this belongs to');
  }
  if (!body.apiKey?.trim()) throw new ValidationError('apiKey is required');

  const { name } = await connectApiKeySource(kind, body.label.trim(), body.apiKey.trim());

  // Prove it works now rather than at the first sync. A credential that is
  // wrong is worth knowing about while the person who has it is still here.
  let verified: { login: string; name: string | null; scopes: string[] } | null = null;
  let problem: string | undefined;
  if (kind === 'github') {
    try {
      verified = await identify(name);
    } catch (err) {
      problem = (err as Error).message;
    }
  }

  res.status(201).json({ name, verified, ...(problem ? { problem } : {}) });
}));

connectionsRouter.delete('/:name', asyncHandler(async (req, res) => {
  const name = String(req.params['name'] ?? '');
  if (!name.startsWith('orgiq-')) throw new NotFoundError('Unknown connection');
  await disconnectSource(name);
  res.json({ ok: true });
}));

// ── GET /:name/check — is this credential still good? ───────────────────────

connectionsRouter.get('/:name/check', asyncHandler(async (req, res) => {
  const name = String(req.params['name'] ?? '');
  try {
    if (name.includes('-github-')) {
      res.json({ ok: true, identity: await identify(name) });
      return;
    }
    // Other kinds have no reader yet; confirm the vault hands it over at all.
    await borrowApiKey(name);
    res.json({ ok: true, identity: null });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message });
  }
}));

// ── GitHub: what this credential can see ────────────────────────────────────

connectionsRouter.get('/:name/github/orgs', asyncHandler(async (req, res) => {
  const name = String(req.params['name'] ?? '');
  const token = await borrowApiKey(name);
  res.json({ orgs: await listOrgs(token) });
}));

connectionsRouter.get('/:name/github/repos', asyncHandler(async (req, res) => {
  const name = String(req.params['name'] ?? '');
  const org = req.query['org'] ? String(req.query['org']) : undefined;
  const limit = Number(req.query['limit'] ?? 30);
  res.json({
    repos: await listRepos(name, { ...(org ? { org } : {}), limit }),
  });
}));

// ── GitHub: contribution signal for one repo ────────────────────────────────
//
// Read-only and previewable on purpose. Nothing is written to the graph from
// here — seeing what the evidence looks like has to come before deciding to
// trust it, because these numbers would otherwise move expertise scores with
// no way to check them first.

connectionsRouter.get('/:name/github/signal', asyncHandler(async (req, res) => {
  const name = String(req.params['name'] ?? '');
  const full = String(req.query['repo'] ?? '');
  const [owner, repo] = full.split('/');
  if (!owner || !repo) throw new ValidationError('repo must be in owner/name form');

  const sinceDays = Number(req.query['sinceDays'] ?? 180);
  const maxCommits = Number(req.query['maxCommits'] ?? 200);

  res.json({
    repo: full,
    signals: await readRepoSignal(name, { owner, name: repo, fullName: full }, { sinceDays, maxCommits }),
  });
}));
