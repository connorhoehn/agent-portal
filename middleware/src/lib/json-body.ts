// The app's JSON body parser: express's default limit (100 KB) for every route but the few that carry a bigger document by
// design, each named with its method, its full path and its limit. Those routes check the size themselves and refuse with a
// sentence; without this the parser's bare 413 came first and their own caps could never be reached.
import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type RequestHandler } from 'express';

export interface LargeJsonRoute {
  method: 'POST' | 'PUT' | 'PATCH';
  /** The whole request path (the router's mount included), anchored. */
  path: RegExp;
  /** The most bytes the body may have, for express.json's `limit`. */
  limit: number;
}

type Verify = (req: IncomingMessage, res: ServerResponse, buf: Buffer, encoding: string) => void;

export function jsonBody(large: readonly LargeJsonRoute[], verify?: Verify): RequestHandler {
  const plain = express.json(verify ? { verify } : {});
  const routes = large.map((r) => ({ ...r, parse: express.json({ limit: r.limit, ...(verify ? { verify } : {}) }) }));
  return (req, res, next) => {
    const hit = routes.find((r) => r.method === req.method && r.path.test(req.path));
    (hit?.parse ?? plain)(req, res, next);
  };
}
