// The run token: what binds a box to ITS run (docs/distillation-runbooks-design.md §3.4).
//
// The lab envelope (LAB_CALLBACK_SERVICE_AUTH, lib/service-auth.ts) proves a
// caller is SOME box of the fleet: every devbox holds the same
// LAB_CALLBACK_SECRET. That is enough for `lab remember`, and not enough for a
// run's brief or its reports — with the fleet secret alone, any box could read
// another run's brief (the task, the project context, the decisions) or move
// another runbook's health by reporting on a run it never was.
//
// So the middleware mints one token per run when it freezes the brief and hands
// it to the box in the invoke payload (LAB_RUN_TOKEN). It is an HMAC under the
// SESSION signing key, which no box ever holds, so a box cannot mint a token
// for a run it was not given. Routes that act on a run (`GET /api/runs/:ref/brief`,
// `GET /api/runs/:ref/runbooks/:id`, a box's proposal and its `lab applied`)
// require the envelope AND a token for exactly that run_ref.
//
// The payload carries a kind marker and no `sub`, so a run token can never be
// presented as a session cookie (verifySession requires `sub` and a role).

import type { Request } from 'express';
import { signValue, verifyValue } from './session.js';

export const RUN_TOKEN_HEADER = 'x-lab-run-token';
const KIND = 'lab-run';

interface RunTokenPayload { k: string; v: number; r: string }

export async function mintRunToken(runRef: string): Promise<string> {
  return signValue({ k: KIND, v: 1, r: runRef } satisfies RunTokenPayload);
}

export async function verifyRunToken(token: string, runRef: string): Promise<boolean> {
  if (!token || token.length > 2048) return false;
  const p = await verifyValue<RunTokenPayload>(token);
  return !!p && p.k === KIND && p.v === 1 && typeof p.r === 'string' && p.r === runRef;
}

/** True when the request carries a run token for exactly `runRef`. */
export async function runTokenMatches(req: Request, runRef: string): Promise<boolean> {
  const raw = req.headers[RUN_TOKEN_HEADER];
  return typeof raw === 'string' && verifyRunToken(raw.trim(), runRef);
}
