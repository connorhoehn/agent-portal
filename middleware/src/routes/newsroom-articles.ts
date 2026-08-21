import { Router } from 'express';
import {
  listArticles,
  getArticle,
  getTodayStats,
  getEntity,
  getClusters,
  getPitches,
  getPitchBoard,
  updatePitchStatus,
  publishArticle,
  PITCH_STATUSES,
} from '../providers/newsroom-articles.js';
import { asyncHandler } from '../lib/async-handler.js';
import { requireAction } from '../lib/authz.js';

export const newsroomArticlesRouter = Router();

// GET /api/newsroom/articles/today — count + section breakdown for today
// NOTE: this route must be defined BEFORE /:id so Express doesn't treat "today" as an id
newsroomArticlesRouter.get(
  '/articles/today',
  asyncHandler(async (_req, res) => {
    const stats = await getTodayStats();
    res.json(stats);
  }),
);

// GET /api/newsroom/articles?beat=&since=ISO&limit=N
newsroomArticlesRouter.get(
  '/articles',
  asyncHandler(async (req, res) => {
    const beat = req.query['beat'] as string | undefined;
    const since = req.query['since'] as string | undefined;
    const rawLimit = parseInt((req.query['limit'] as string) ?? '50', 10);
    const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);

    const articles = await listArticles({
      beat: beat || undefined,
      since: since || undefined,
      limit,
    });
    res.json(articles);
  }),
);

// GET /api/newsroom/articles/:id — single article + entities + sources + cluster
newsroomArticlesRouter.get(
  '/articles/:id',
  asyncHandler(async (req, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !id) {
      res.status(400).json({ error: 'Invalid article id' });
      return;
    }
    const article = await getArticle(id);
    if (!article) {
      res.status(404).json({ error: 'Article not found' });
      return;
    }
    res.json(article);
  }),
);

// GET /api/newsroom/entities/:id — entity detail + appearances + co-mentions
newsroomArticlesRouter.get(
  '/entities/:id',
  asyncHandler(async (req, res) => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !id) {
      res.status(400).json({ error: 'Invalid entity id' });
      return;
    }
    const entity = await getEntity(id);
    if (!entity) {
      res.status(404).json({ error: 'Entity not found' });
      return;
    }
    res.json(entity);
  }),
);

// GET /api/newsroom/clusters?status=active — cluster summary for the home page
newsroomArticlesRouter.get(
  '/clusters',
  asyncHandler(async (_req, res) => {
    res.json(await getClusters());
  }),
);

// GET /api/newsroom/pitches/board — the full desk view: every pitch with its
// beat, proposer, assignee and cluster, plus counts per status. Declared
// before /pitches so Express never mistakes "board" for a query on it.
newsroomArticlesRouter.get(
  '/pitches/board',
  asyncHandler(async (_req, res) => {
    res.json(await getPitchBoard());
  }),
);

// GET /api/newsroom/pitches?status=open — pitch summary for the home page
newsroomArticlesRouter.get(
  '/pitches',
  asyncHandler(async (req, res) => {
    const status = (req.query['status'] as string) || 'open';
    res.json(await getPitches(status));
  }),
);

// PATCH /api/newsroom/pitches/:id — desk decision on a pitch.
// ManagePitches: reporters + editors hold it; orgiq roles do not.
newsroomArticlesRouter.patch(
  '/pitches/:id',
  requireAction('ManagePitches'),
  asyncHandler(async (req, res) => {
    const { status } = req.body as { status?: string };
    if (!status || !(PITCH_STATUSES as readonly string[]).includes(status)) {
      res.status(400).json({ error: `status must be one of ${PITCH_STATUSES.join(', ')}` });
      return;
    }
    const id = String(req.params['id']);
    const ok = await updatePitchStatus(id, status);
    if (!ok) { res.status(404).json({ error: 'Pitch not found' }); return; }
    res.json({ id, status });
  }),
);

// POST /api/newsroom/articles/:id/publish — editor-only publish authority.
newsroomArticlesRouter.post(
  '/articles/:id/publish',
  requireAction('PublishArticle'),
  asyncHandler(async (req, res) => {
    const id = String(req.params['id']);
    const ok = await publishArticle(id);
    if (!ok) { res.status(404).json({ error: 'Article not found' }); return; }
    res.json({ id, status: 'published' });
  }),
);
