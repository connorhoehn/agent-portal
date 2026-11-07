import type { Request, Response, NextFunction, RequestHandler } from 'express';

export class AppError extends Error {
  public readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends AppError {
  constructor(message: string) { super(400, message); }
}

/** A BFF-owned session/provenance refusal, distinct from an upstream 401. */
export class SessionInvalidError extends AppError {
  public readonly code = 'SESSION_INVALID';
  constructor(message = 'The session is no longer current. Sign in again.') { super(401, message); }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(404, message); }
}

/**
 * A money refusal thrown from below a route (lib/spend-refusal.ts renders the
 * status, body and headers): the error handler answers it with that exact
 * shape, so a path that reserves spend deep in a library (`/summarize`'s
 * startRun) refuses the same way a route that renders it inline does.
 */
export class SpendRefusedError extends AppError {
  constructor(status: number, readonly body: Record<string, unknown>, readonly headers: Record<string, string> = {}) {
    super(status, typeof body['error'] === 'string' ? body['error'] : 'spend refused');
  }
}

export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return ((req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  }) as RequestHandler;
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) { next(err); return; }
  if (err instanceof SpendRefusedError) {
    res.set(err.headers).status(err.status).json(err.body);
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, ...(err instanceof SessionInvalidError ? { code: err.code } : {}) });
    return;
  }
  console.error('[middleware] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
