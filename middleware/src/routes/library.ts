// The asset library — /api/library.
//
// One catalog for every kind of instruction the fleet runs on: agent system
// prompts, prompts a person invokes, evaluators a pipeline calls. Runbooks, not this catalog, are the only place
// procedures live. Reads are open to
// the tenant, because knowing what the org's agents can be asked to do is not
// privileged — authoring and deploying are (routes/prompt-history.ts,
// canary-library.ts).

import { Router } from 'express';
import { asyncHandler, NotFoundError } from '../lib/async-handler.js';
import { listAssets, getAsset, relatedAssets } from '../providers/prompt-library.js';
import { decideDeploy, contractDrift } from '../lib/prompt-contract.js';

export const libraryRouter: Router = Router();

// GET /api/library?q=&kind=&tier=&role=&limit=
// Facets always describe the whole catalog, so a filter can be widened again.
libraryRouter.get('/', asyncHandler(async (req, res) => {
  const rawLimit = parseInt(String(req.query['limit'] ?? '100'), 10);
  res.json(await listAssets({
    q: String(req.query['q'] ?? ''),
    kind: String(req.query['kind'] ?? 'all'),
    tier: String(req.query['tier'] ?? 'all'),
    role: String(req.query['role'] ?? 'all'),
    limit: Number.isNaN(rawLimit) ? 100 : rawLimit,
  }));
}));

// GET /api/library/:id — the asset, its release readiness, and its top-k
// neighbours (each carrying the reason it is a neighbour).
//
// Readiness is computed rather than stored: the gate is a function of the
// asset's CURRENT tier, contract, owner, evals and sign-offs, so caching it
// would let the page claim a version is shippable after the thing that made
// it shippable was taken away.
libraryRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = String(req.params['id'] ?? '');
  const asset = await getAsset(id);
  if (!asset) throw new NotFoundError('asset not found');

  // The ASSET's kind/tier are authoritative, not the contract's copy of them.
  // Both places carry the fields (the contract travels with a version, the
  // asset is the catalog row) and a drifted copy would make the gate judge the
  // wrong tier — the one failure a release gate must never have.
  const effective = { ...asset.contract, kind: asset.kind, tier: asset.tier };

  const decision = decideDeploy(effective, asset.template, {
    hasOwner: asset.ownerName != null,
    evalPassRate: asset.evalPassRate,
    signoffs: asset.signoffs,
  });
  const drift = contractDrift(asset.template, effective);

  res.json({
    asset,
    readiness: {
      ok: decision.ok,
      ...(decision.ok ? {} : { reason: decision.reason }),
      tier: asset.tier,
      // Named so the drawer can show the checklist rather than one verdict —
      // "not shippable" is far less useful than "not shippable BECAUSE".
      checks: {
        contractComplete: drift.undeclared.length === 0,
        undeclared: drift.undeclared,
        hasOwner: asset.ownerName != null,
        evaluated: asset.evalPassRate != null,
        evalPassRate: asset.evalPassRate,
        guardrailBound: Boolean(effective.guardrailId),
        signoffs: asset.signoffs,
      },
    },
    related: await relatedAssets(id),
  });
}));
