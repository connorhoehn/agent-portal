// The interviews tenant's action gate: "not found, never forbidden" (docs/interviews-tenant-plan.md, the standing
// rule). A tenant member without the action reads the same not-found the route gives for a row outside their scope,
// never a 403 that says the thing is there. No session and an authorization failure keep requireAction's answers.
import { NotFoundError } from '../async-handler.js';
import { requireActionOr } from '../authz.js';

export function interviewsAction(action: string, notFound: string) {
  return requireActionOr(action, (_req, _res, next) => next(new NotFoundError(notFound)));
}
