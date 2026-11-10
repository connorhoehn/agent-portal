// The lab loop's durable half — fleet memory and human consults.
//
// A computer-lab session is a cache (wiped on redeploy, 14-day idle reset);
// these two stores are what a session is ALLOWED to keep:
//
//   experiences — what a run learned, keyed by repo/initiative so the next
//                 session working the same code can recall it before starting.
//   consults    — a question for a human. The agent blocks (polls) on it; a
//                 person answers from the Work page; the answer flows back
//                 into the running session. Approvals' lifecycle, but the
//                 payload is a question and prose, not an amount and a verdict.
//
// (Signals — issues noticed outside the task — are NOT here: they file into
// agent_findings via org-sweeps.fileLabSignal and ride the findings pipeline.)
//
// Same mock discipline as agent-jobs: config.mock.aurora switches every
// function to an in-memory store with identical semantics, so the whole loop
// is demoable and testable with dev:mock.

import { exec } from './aurora.js';
import { config } from '../config.js';
import { ValidationError } from '../lib/async-handler.js';
// The mock stores below are fixture writes living outside src/mock, so their
// stamps come from the one clock rather than `new Date()` — freezeClock can
// then pin what a write recorded, and expireStale reads the same instant the
// row was written against instead of racing wall time.
import { clock } from '../mock/core/index.js';
// The rows themselves live behind registered fixtures, so a recorded
// experience or an answered consult is undone by `POST /api/__mock/reset`.
import {
  labConsults, labExperiences, nextMockConsultId, nextMockExperienceId, SEEDED_CONSULT_LIFETIME_MS,
} from '../mock/lab.js';
import { type SqlParameter } from '@aws-sdk/client-rds-data';

const s = (name: string, value: string): SqlParameter => ({ name, value: { stringValue: value } });
const i = (name: string, value: number): SqlParameter => ({ name, value: { longValue: value } });
const toStr = (v: unknown, f = ''): string => (typeof v === 'string' ? v : v == null ? f : String(v));

// ── Experiences ─────────────────────────────────────────────────────────────

export type ExperienceKind = 'worked' | 'failed' | 'gotcha' | 'decision' | 'convention';
export const EXPERIENCE_KINDS: readonly ExperienceKind[] = ['worked', 'failed', 'gotcha', 'decision', 'convention'];

export interface LabExperience {
  id: string;
  sessionId: string | null;
  boxId: string | null;
  repo: string | null;
  initiativeId: string | null;
  kind: ExperienceKind;
  title: string;
  body: string | null;
  tags: string[];
  createdAt: string;
}

export async function recordExperience(input: {
  sessionId?: string; boxId?: string; repo?: string; initiativeId?: string;
  kind: ExperienceKind; title: string; body?: string; tags?: string[];
}): Promise<LabExperience> {
  if (config.mock.aurora) {
    const exp: LabExperience = {
      id: nextMockExperienceId(),
      sessionId: input.sessionId ?? null,
      boxId: input.boxId ?? null,
      repo: input.repo ?? null,
      initiativeId: input.initiativeId ?? null,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      tags: input.tags ?? [],
      createdAt: clock.nowIso(),
    };
    labExperiences.rows().push(exp);
    return exp;
  }
  const rows = await exec(
    `INSERT INTO lab_experiences (session_id, box_id, repo, initiative_id, kind, title, body, tags)
     VALUES (NULLIF(:sid, ''), NULLIF(:box, ''), NULLIF(:repo, ''), NULLIF(:init, ''), :kind, :title, NULLIF(:body, ''), string_to_array(NULLIF(:tags, ''), ','))
     RETURNING id, session_id, box_id, repo, initiative_id, kind, title, body,
               array_to_string(tags, ',') AS tags, created_at::text AS created_at`,
    [
      s('sid', input.sessionId ?? ''), s('box', input.boxId ?? ''),
      s('repo', input.repo ?? ''), s('init', input.initiativeId ?? ''),
      s('kind', input.kind), s('title', input.title), s('body', input.body ?? ''),
      s('tags', (input.tags ?? []).join(',')),
    ],
  );
  return rowToExperience(rows[0] ?? {});
}

export async function listExperiences(opts: {
  repo?: string; initiativeId?: string; limit?: number;
} = {}): Promise<LabExperience[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  if (config.mock.aurora) {
    return labExperiences.rows()
      .filter((e) =>
        (!opts.repo || e.repo === opts.repo) &&
        (!opts.initiativeId || e.initiativeId === opts.initiativeId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const where: string[] = [];
  const params: SqlParameter[] = [i('lim', limit)];
  if (opts.repo) { where.push('repo = :repo'); params.push(s('repo', opts.repo)); }
  if (opts.initiativeId) { where.push('initiative_id = :init'); params.push(s('init', opts.initiativeId)); }
  const rows = await exec(
    `SELECT id, session_id, box_id, repo, initiative_id, kind, title, body,
            array_to_string(tags, ',') AS tags, created_at::text AS created_at
       FROM lab_experiences
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY created_at DESC
      LIMIT :lim`,
    params,
  );
  return rows.map(rowToExperience);
}

function rowToExperience(r: Record<string, unknown>): LabExperience {
  const tags = toStr(r['tags']);
  return {
    id: toStr(r['id']),
    sessionId: r['session_id'] ? toStr(r['session_id']) : null,
    boxId: r['box_id'] ? toStr(r['box_id']) : null,
    repo: r['repo'] ? toStr(r['repo']) : null,
    initiativeId: r['initiative_id'] ? toStr(r['initiative_id']) : null,
    kind: toStr(r['kind'], 'gotcha') as ExperienceKind,
    title: toStr(r['title']),
    body: r['body'] ? toStr(r['body']) : null,
    tags: tags ? tags.split(',').filter(Boolean) : [],
    createdAt: toStr(r['created_at']),
  };
}

// ── Consults ────────────────────────────────────────────────────────────────

// A pending consult a human never sees again would strand its poller; the
// approvals pattern's server-side expiry applies. Longer window than an
// approval's 5min: a consult is "answer when you can", not "the workflow is
// mid-transaction" — but the agent's own poll timeout stays the real bound.
export const CONSULT_EXPIRY_MS = 30 * 60 * 1000;

export interface LabConsult {
  id: string;
  sessionId: string | null;
  boxId: string | null;
  repo: string | null;
  initiativeId: string | null;
  question: string;
  context: string | null;
  status: 'pending' | 'answered' | 'expired' | 'withdrawn';
  answer: string | null;
  answeredBy: string | null;
  createdAt: string;
  answeredAt: string | null;
}

/** How long a pending consult waits before it expires: 30 minutes, longer for the one the mock seeds for a demo. */
function consultLifetimeMs(c: LabConsult): number {
  return (config.mock.aurora ? SEEDED_CONSULT_LIFETIME_MS[c.id] : undefined) ?? CONSULT_EXPIRY_MS;
}

function expireStale(c: LabConsult): LabConsult {
  // `clock.now()`, not `Date.now()`: openConsult stamps createdAt from the
  // clock, so measuring its age against wall time would expire every consult a
  // frozen-clock test opens in the past — and would leave a consult opened
  // under a freeze un-expirable forever.
  if (c.status === 'pending' && clock.now().getTime() - Date.parse(c.createdAt) > consultLifetimeMs(c)) {
    c.status = 'expired';
  }
  return c;
}

export async function openConsult(input: {
  sessionId?: string; boxId?: string; repo?: string; initiativeId?: string;
  question: string; context?: string;
}): Promise<LabConsult> {
  if (config.mock.aurora) {
    const con: LabConsult = {
      id: nextMockConsultId(),
      sessionId: input.sessionId ?? null,
      boxId: input.boxId ?? null,
      repo: input.repo ?? null,
      initiativeId: input.initiativeId ?? null,
      question: input.question,
      context: input.context ?? null,
      status: 'pending',
      answer: null,
      answeredBy: null,
      createdAt: clock.nowIso(),
      answeredAt: null,
    };
    labConsults.rows().push(con);
    return con;
  }
  const rows = await exec(
    `INSERT INTO lab_consults (session_id, box_id, repo, initiative_id, question, context)
     VALUES (NULLIF(:sid, ''), NULLIF(:box, ''), NULLIF(:repo, ''), NULLIF(:init, ''), :q, NULLIF(:ctx, ''))
     RETURNING ${CONSULT_COLUMNS}`,
    [
      s('sid', input.sessionId ?? ''), s('box', input.boxId ?? ''),
      s('repo', input.repo ?? ''), s('init', input.initiativeId ?? ''),
      s('q', input.question), s('ctx', input.context ?? ''),
    ],
  );
  return rowToConsult(rows[0] ?? {});
}

export async function getConsult(id: string): Promise<LabConsult | null> {
  if (config.mock.aurora) {
    const c = labConsults.rows().find((x) => x.id === id);
    return c ? expireStale(c) : null;
  }
  // Expiry on read, like approvals: a crashed poller's consult can't linger.
  await exec(
    `UPDATE lab_consults SET status = 'expired'
      WHERE id = :id AND status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes'`,
    [s('id', id)],
  );
  const rows = await exec(
    `SELECT ${CONSULT_COLUMNS} FROM lab_consults WHERE id = :id`,
    [s('id', id)],
  );
  return rows[0] ? rowToConsult(rows[0]) : null;
}

export async function listConsults(opts: { status?: string; limit?: number } = {}): Promise<LabConsult[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  if (config.mock.aurora) {
    const rows = labConsults.rows();
    rows.forEach(expireStale);
    return rows
      .filter((c) => !opts.status || c.status === opts.status)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  await exec(
    `UPDATE lab_consults SET status = 'expired'
      WHERE status = 'pending' AND created_at < NOW() - INTERVAL '30 minutes'`,
  );
  const params: SqlParameter[] = [i('lim', limit)];
  let where = '';
  if (opts.status) { where = 'WHERE status = :status'; params.push(s('status', opts.status)); }
  const rows = await exec(
    `SELECT ${CONSULT_COLUMNS} FROM lab_consults ${where}
      ORDER BY created_at DESC LIMIT :lim`,
    params,
  );
  return rows.map(rowToConsult);
}

/**
 * The longest answer a consult takes, whatever client sent it (sweep 12, U1).
 * The voice card caps its note at 500 characters (portal lib/voice/records.ts
 * ANSWER_MAX), but the answer route and the approvals inbox's decide (which
 * answers with "Approved — <note>") are reachable without that card, and the
 * answer is fed back into a running agent's session as prose. Generous
 * enough for a typed paragraph or two; enforced here so both routes share it.
 */
export const CONSULT_ANSWER_MAX = 2000;

/** Answer a pending consult. Attribution comes from the session, never the body. */
export async function answerConsult(id: string, answer: string, answeredBy: string): Promise<LabConsult | null> {
  if (answer.length > CONSULT_ANSWER_MAX) throw new ValidationError(`an answer is at most ${CONSULT_ANSWER_MAX} characters`);
  if (config.mock.aurora) {
    const c = labConsults.rows().find((x) => x.id === id);
    if (!c || expireStale(c).status !== 'pending') return null;
    c.status = 'answered';
    c.answer = answer;
    c.answeredBy = answeredBy;
    c.answeredAt = clock.nowIso();
    return c;
  }
  const rows = await exec(
    `UPDATE lab_consults
        SET status = 'answered', answer = :answer, answered_by = :by, answered_at = NOW()
      WHERE id = :id AND status = 'pending'
      RETURNING ${CONSULT_COLUMNS}`,
    [s('id', id), s('answer', answer), s('by', answeredBy)],
  );
  return rows[0] ? rowToConsult(rows[0]) : null;
}

const CONSULT_COLUMNS = `id, session_id, box_id, repo, initiative_id, question, context, status,
  answer, answered_by, created_at::text AS created_at, answered_at::text AS answered_at`;

function rowToConsult(r: Record<string, unknown>): LabConsult {
  return {
    id: toStr(r['id']),
    sessionId: r['session_id'] ? toStr(r['session_id']) : null,
    boxId: r['box_id'] ? toStr(r['box_id']) : null,
    repo: r['repo'] ? toStr(r['repo']) : null,
    initiativeId: r['initiative_id'] ? toStr(r['initiative_id']) : null,
    question: toStr(r['question']),
    context: r['context'] ? toStr(r['context']) : null,
    status: toStr(r['status'], 'pending') as LabConsult['status'],
    answer: r['answer'] ? toStr(r['answer']) : null,
    answeredBy: r['answered_by'] ? toStr(r['answered_by']) : null,
    createdAt: toStr(r['created_at']),
    answeredAt: r['answered_at'] ? toStr(r['answered_at']) : null,
  };
}
