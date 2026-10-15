// The session brief over HTTP (docs/distillation-runbooks-design.md §3.4–§3.5; lane D / R3).
//
//   GET /api/runs/:ref/brief                the FROZEN brief a run was given
//   GET /api/work-items/:id/brief-preview   what a run would be given now (assembled, never stored)
//
// Mounted at /api with NO blanket gate: the first is read by two kinds of caller —
// a box (devbox `lab brief`, a signed LAB_CALLBACK_SERVICE_AUTH envelope, no cookie)
// and a person (the run's Brief tab, session + Cedar ViewSessionBrief). Per-route
// guards, the lab.ts rule: a mount-level session floor would 401 the fleet.
//
// A box and the portal read the SAME bytes: `?format=markdown` (or `Accept:
// text/markdown`) returns the brief's markdown verbatim with its sha256 in
// `X-Brief-Sha256`/`ETag`; the JSON form carries `brief.sha256` for the portal to
// compare. The brief is write-once, so the response is immutable.

import { Router, type RequestHandler } from 'express';
import { asyncHandler, ValidationError } from '../lib/async-handler.js';
import { requireAction, requireTenant } from '../lib/authz.js';
import { rateLimit } from '../lib/rate-limit.js';
import { LAB_CALLBACK_SERVICE_AUTH, hasServiceAuth } from '../lib/service-auth.js';
import { previewBrief } from '../lib/session-brief-preview.js';
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

export function createSessionBriefsRouter(deps: SessionBriefDeps): Router {
  const router = Router();

  router.get('/runs/:ref/brief', briefLimit, machineMark,
    unlessMachine(requireTenant('orgiq')), unlessMachine(requireAction('ViewSessionBrief')),
    asyncHandler(async (req, res) => {
      const s = await deps.store();
      const brief = await s.getBrief(String(req.params['ref']));
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

  router.get('/work-items/:id/brief-preview', briefLimit, requireTenant('orgiq'), requireAction('ViewSessionBrief'),
    asyncHandler(async (req, res) => {
      const id = String(req.params['id']);
      const pinned = String(req.query['pin'] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
      for (const p of pinned) if (!RUNBOOK_ID.test(p)) throw new ValidationError(`pin: "${p}" is not a runbook id`);

      const { getWorkItem, getProjectDecisions } = await import('../providers/work-items.js');
      const work = await getWorkItem(id);
      if (!work) { res.status(404).json({ error: 'work item not found' }); return; }
      const { getProject } = await import('../providers/projects.js');
      const [project, parent, decisions] = await Promise.all([
        work.projectId ? getProject(work.projectId) : Promise.resolve(null),
        work.parentId ? getWorkItem(work.parentId) : Promise.resolve(null),
        work.projectId ? getProjectDecisions(work.projectId) : Promise.resolve([]),
      ]);
      // Decisions that bind THIS work: the ones attached to it, plus project-wide ones already settled.
      const binding = decisions.filter((d) => d.workItemId === work.id || (d.workItemId === null && d.status === 'resolved'));

      const brief = await previewBrief({
        store: await deps.store(),
        work: {
          id: work.id, title: work.title, description: work.description, type: work.type,
          storyPoints: work.storyPoints, labels: work.labels, parentId: work.parentId,
        },
        parent: parent ? { title: parent.title } : null,
        project: project ? { id: project.id, name: project.name, repoFullName: project.repoFullName } : null,
        decisions: binding,
        pinned,
        nowIso: clock.nowIso(),
      });
      res.json({ brief, stored: false, pinned });
    }));

  return router;
}

export const sessionBriefsRouter: Router = createSessionBriefsRouter({
  store: async () => (await import('../lib/runbooks/store-select.js')).runbookStore(),
});
