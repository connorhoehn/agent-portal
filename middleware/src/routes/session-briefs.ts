// The session brief over HTTP (docs/distillation-runbooks-design.md §3.4–§3.5; lane D / R3).
//
//   GET /api/briefs                         frozen briefs, newest first, WITHOUT their markdown (the Briefs list)
//   GET /api/runs/:ref/brief                the FROZEN brief a run was given
//   GET /api/runs/:ref/runbooks/:id         a runbook that brief named (`lab runbook <id>`), as markdown
//   GET /api/work-items/:id/brief-preview   what a run would be given now (assembled, never stored)
//
// Mounted at /api with NO blanket gate: the first is read by two kinds of caller —
// a box (devbox `lab brief`, a signed LAB_CALLBACK_SERVICE_AUTH envelope, no cookie)
// and a person (the run's Brief tab, session + Cedar ViewSessionBrief). Per-route
// guards, the lab.ts rule: a mount-level session floor would 401 the fleet.
//
// A box presents the lab envelope (some box of the fleet) AND the run token
// for exactly :ref (lib/run-token.ts, minted at dispatch/claim, never derivable
// from the fleet secret): a box reads its own run and no other.
//
// A box and the portal read the SAME bytes: `?format=markdown` (or `Accept:
// text/markdown`) returns the brief's markdown verbatim with its sha256 in
// `X-Brief-Sha256`/`ETag`; the JSON form carries `brief.sha256` for the portal to
// compare. The brief is write-once, so the response is immutable.

import { Router, type RequestHandler, type Response } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction, requireTenant } from '../lib/authz.js';
import { rateLimit } from '../lib/rate-limit.js';
import { LAB_CALLBACK_SERVICE_AUTH, hasServiceAuth } from '../lib/service-auth.js';
import { previewBrief } from '../lib/session-brief-preview.js';
import { liveBundleSkills, loadWorkContext } from '../lib/run-brief.js';
import { RUN_TOKEN_HEADER, runTokenMatches } from '../lib/run-token.js';
import type { RunbookStore } from '../lib/runbooks/index.js';
import { clock } from '../mock/core/clock.js';

export interface SessionBriefDeps {
  store: () => RunbookStore | Promise<RunbookStore>;
}

const RUNBOOK_ID = /^rb-[a-z0-9][a-z0-9-]{1,58}$/;

/** One hasServiceAuth per request (a signed envelope's nonce is single-use). */
const machineMark: RequestHandler = (req, res, next) => {
  if (hasServiceAuth(req, LAB_CALLBACK_SERVICE_AUTH)) res.locals['machine'] = true;
  next();
};
const unlessMachine = (human: RequestHandler): RequestHandler => (req, res, next) => {
  if (res.locals['machine']) { next(); return; }
  void human(req, res, next);
};

const briefLimit = rateLimit('session-brief', 240, 60_000);

function refuseRunToken(res: Response): void {
  res.status(403).json({ error: `a box reads only its own run: present ${RUN_TOKEN_HEADER} for this run`, code: 'RUN_TOKEN' });
}

export function createSessionBriefsRouter(deps: SessionBriefDeps): Router {
  const router = Router();

  // The Briefs list (portal /iq/runbooks/briefs): people only, summaries only. The bytes stay behind
  // /runs/:ref/brief so the sha a row shows is read against the markdown a person opens.
  router.get('/briefs', briefLimit, requireTenant('orgiq'), requireAction('ViewSessionBrief'),
    asyncHandler(async (req, res) => {
      const rawLimit = Number(req.query['limit']);
      const cursor = typeof req.query['cursor'] === 'string' && req.query['cursor'] ? req.query['cursor'] : undefined;
      const page = await (await deps.store()).listBriefs({
        ...(cursor ? { cursor } : {}),
        ...(Number.isInteger(rawLimit) && rawLimit > 0 ? { limit: Math.min(rawLimit, 200) } : {}),
      });
      res.json({
        briefs: page.items.map(({ markdown: _markdown, ...summary }) => summary),
        next: page.next,
      });
    }));

  router.get('/runs/:ref/brief', briefLimit, machineMark,
    unlessMachine(requireTenant('orgiq')), unlessMachine(requireAction('ViewSessionBrief')),
    asyncHandler(async (req, res) => {
      const ref = String(req.params['ref']);
      // The fleet secret proves "some box"; only this run's token proves "the box running THIS run".
      if (res.locals['machine'] && !(await runTokenMatches(req, ref))) { refuseRunToken(res); return; }
      const s = await deps.store();
      const brief = await s.getBrief(ref);
      if (!brief) { res.status(404).json({ error: 'no brief was frozen for this run', code: 'NO_BRIEF' }); return; }
      res.setHeader('ETag', `"${brief.sha256}"`);
      res.setHeader('X-Brief-Id', brief.id);
      res.setHeader('X-Brief-Sha256', brief.sha256);
      res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
      const wantsMarkdown = req.query['format'] === 'markdown' || /\btext\/markdown\b/.test(String(req.headers['accept'] ?? ''));
      if (wantsMarkdown) {
        res.type('text/markdown; charset=utf-8').send(brief.markdown);
        return;
      }
      res.json({ brief });
    }));

  // `lab runbook <id>`: a runbook the run's brief named but did not include in full ("Also
  // available"), or one it did include. Bound to the run like the brief itself; a runbook the
  // brief never mentioned is not this run's to read through this door.
  router.get('/runs/:ref/runbooks/:id', briefLimit, machineMark,
    unlessMachine(requireTenant('orgiq')), unlessMachine(requireAction('ViewSessionBrief')),
    asyncHandler(async (req, res) => {
      const ref = String(req.params['ref']);
      const id = String(req.params['id']);
      if (!RUNBOOK_ID.test(id)) throw new ValidationError('not a runbook id');
      if (res.locals['machine'] && !(await runTokenMatches(req, ref))) { refuseRunToken(res); return; }
      const s = await deps.store();
      const brief = await s.getBrief(ref);
      const named = brief && (brief.sections.some((x) => x.kind === 'runbook' && x.ref === id) || brief.omitted.some((o) => o.runbook_id === id));
      if (!brief || !named) { res.status(404).json({ error: `run ${ref} was not given ${id}`, code: 'NOT_GIVEN' }); return; }
      const rb = await s.getRunbook(id);
      const given = brief.sections.find((x) => x.kind === 'runbook' && x.ref === id)?.version;
      const version = rb ? await s.getVersion(id, given ?? rb.current_version) : null;
      if (!rb || !version || (given === undefined && rb.status !== 'published')) { res.status(404).json({ error: `${id} is not available`, code: 'NOT_AVAILABLE' }); return; }
      res.setHeader('X-Runbook-Version', String(version.version));
      res.setHeader('X-Runbook-Sha256', version.sha256);
      res.type('text/markdown; charset=utf-8').send(version.markdown);
    }));

  router.get('/work-items/:id/brief-preview', briefLimit, requireTenant('orgiq'), requireAction('ViewSessionBrief'),
    asyncHandler(async (req, res) => {
      const id = String(req.params['id']);
      const pinned = String(req.query['pin'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      for (const p of pinned) if (!RUNBOOK_ID.test(p)) throw new ValidationError(`pin: "${p}" is not a runbook id`);

      // The same context reading and the same skills a dispatched devbox run gets (lib/run-brief.ts).
      const ctx = await loadWorkContext(id);
      if (!ctx) { res.status(404).json({ error: 'work item not found' }); return; }
      const brief = await previewBrief({
        store: await deps.store(),
        ...ctx,
        pinned,
        nowIso: clock.nowIso(),
        skills: await liveBundleSkills(),
      });
      res.json({ brief, stored: false, pinned });
    }));

  return router;
}

export const sessionBriefsRouter: Router = createSessionBriefsRouter({
  store: async () => (await import('../lib/runbooks/store-select.js')).runbookStore(),
});
