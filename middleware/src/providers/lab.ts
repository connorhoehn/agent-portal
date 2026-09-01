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

const MOCK_EXPERIENCES: LabExperience[] = [];
let expSeq = 0;

export async function recordExperience(input: {
  sessionId?: string; boxId?: string; repo?: string; initiativeId?: string;
  kind: ExperienceKind; title: string; body?: string; tags?: string[];
}): Promise<LabExperience> {
  if (config.mock.aurora) {
    const exp: LabExperience = {
      id: `exp-mock-${++expSeq}`,
      sessionId: input.sessionId ?? null,
      boxId: input.boxId ?? null,
      repo: input.repo ?? null,
      initiativeId: input.initiativeId ?? null,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      tags: input.tags ?? [],
      createdAt: new Date().toISOString(),
    };
    MOCK_EXPERIENCES.push(exp);
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
    return MOCK_EXPERIENCES
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

const MOCK_CONSULTS: LabConsult[] = [];
let conSeq = 0;

function expireStale(c: LabConsult): LabConsult {
  if (c.status === 'pending' && Date.now() - Date.parse(c.createdAt) > CONSULT_EXPIRY_MS) {
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
      id: `con-mock-${++conSeq}`,
      sessionId: input.sessionId ?? null,
      boxId: input.boxId ?? null,
      repo: input.repo ?? null,
      initiativeId: input.initiativeId ?? null,
      question: input.question,
      context: input.context ?? null,
      status: 'pending',
      answer: null,
      answeredBy: null,
      createdAt: new Date().toISOString(),
      answeredAt: null,
    };
    MOCK_CONSULTS.push(con);
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
    const c = MOCK_CONSULTS.find((x) => x.id === id);
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
    MOCK_CONSULTS.forEach(expireStale);
    return MOCK_CONSULTS
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

/** Answer a pending consult. Attribution comes from the session, never the body. */
export async function answerConsult(id: string, answer: string, answeredBy: string): Promise<LabConsult | null> {
  if (config.mock.aurora) {
    const c = MOCK_CONSULTS.find((x) => x.id === id);
    if (!c || expireStale(c).status !== 'pending') return null;
    c.status = 'answered';
    c.answer = answer;
    c.answeredBy = answeredBy;
    c.answeredAt = new Date().toISOString();
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
