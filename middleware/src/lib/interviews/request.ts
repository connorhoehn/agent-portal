// What an interviews route needs from a request: the viewer's index over the rows they may read, the
// people lookup, and a path parameter. Shared by routes/interviews.ts and any sub-router mounted on it.

import type { Request } from 'express';
import { resolveSession } from '../authz.js';
import { interviewsStore } from './store-select.js';
import { loadWorld } from './store.js';
import { visibleWorld, type Viewer } from './scope.js';
import { WorldIndex, type People } from './views.js';
import { listUsers } from '../../providers/identity.js';

export async function peopleLookup(): Promise<People> {
  const names = new Map((await listUsers()).map((u) => [u.id, u.displayName]));
  return (id: string) => ({ id, name: names.get(id) ?? 'Someone without an account here' });
}

/** The viewer's index over the rows they may read. */
export async function indexFor(req: Request): Promise<WorldIndex> {
  const session = resolveSession(req)!;
  const viewer: Viewer = { id: session.sub, role: session.role };
  const [world, people] = await Promise.all([loadWorld(interviewsStore()), peopleLookup()]);
  return new WorldIndex(visibleWorld(world, viewer), people, viewer);
}

export const param = (req: Request, name: string): string => String(req.params[name] ?? '');
