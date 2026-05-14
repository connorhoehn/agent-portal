import { Router } from 'express';
import { listProjects, getProject } from '../providers/projects.js';
import { asyncHandler } from '../lib/async-handler.js';

export const projectsRouter = Router();

// GET /api/graph/projects?status=&limit=N
projectsRouter.get('/', asyncHandler(async (req, res) => {
  const status = req.query['status'] as string | undefined;
  const rawLimit = parseInt(req.query['limit'] as string ?? '50', 10);
  const limit = Number.isNaN(rawLimit) ? 50 : Math.min(Math.max(rawLimit, 1), 200);

  const projects = await listProjects({ status: status || undefined, limit });
  res.json(projects);
}));

// GET /api/graph/projects/:id
projectsRouter.get('/:id', asyncHandler(async (req, res) => {
  const id = req.params['id'];
  if (typeof id !== 'string' || !id) {
    res.status(400).json({ error: 'Invalid project id' });
    return;
  }
  const project = await getProject(id);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  res.json(project);
}));
