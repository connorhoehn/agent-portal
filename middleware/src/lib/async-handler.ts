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

export class NotFoundError extends AppError {
  constructor(message = 'Not found') { super(404, message); }
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
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error('[middleware] unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
}
