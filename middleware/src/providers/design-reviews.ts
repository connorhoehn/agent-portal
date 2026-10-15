// Design reviews — the Design phase's ADR system.
//
// One review per design question on an initiative: agents open a thread by
// restating the problem, iterate options, and RAISE QUESTIONS when intent is
// ambiguous (human-in-the-loop); people answer, agents revise, and the loop
// runs until a decision post exists and the stewards SIGN OFF. An approved
// review is an ADR: it is logged, it syncs to the knowledge base, and it
// becomes a GATED INPUT — a review that depends on it cannot be approved
// while it is not.
//
// Aurora tables in schema/design_reviews_schema.sql; the mock mirrors three
// canonical threads (approved / awaiting input / gated) so the whole loop is
// demoable offline. Mock writes mutate in-memory state so answer → agent
// revision → sign-off → KB sync all actually happen in a dev session.

import { noteSearchWrite } from '../lib/search-index/writes.js';
import { config } from '../config.js';
import { designReviewDocs, type DesignReviewDoc } from '../mock/design-reviews.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export type DesignStatus =
  | 'ideating' | 'awaiting_input' | 'proposed' | 'approved' | 'rejected' | 'superseded';

export type PostKind =
  | 'problem' | 'analysis' | 'option' | 'question' | 'answer'
  | 'artifact' | 'revision' | 'decision';

export interface DesignPost {
  id: string;
  /** 'agent' posts come from the fleet; 'human' from a signed-in person. */
  authorKind: 'agent' | 'human';
  authorName: string;
  kind: PostKind;
  body: string;
  /** question posts: null while open; the answer post id once resolved. */
  resolvedBy: string | null;
  /** artifact posts: what the agent produced (browser screenshot, doc, diagram). */
  artifact: { name: string; type: string; url: string | null } | null;
  createdAt: string;
}

export interface DesignSignoff {
  personName: string;
  role: string;
  decision: 'approve' | 'reject';
  at: string;
}

export interface DesignReview {
  id: string;
  orgProjectId: string;
  orgProjectName: string;
  title: string;
  status: DesignStatus;
  /** The agent-maintained executive summary — what is being decided and where
      it stands, kept current as the thread evolves. */
  summary: string;
  /** Every initiative this decision touches beyond its home — the blast
      radius a reviewer needs before reading a single post. */
  affected: Array<{ orgProjectId: string; orgProjectName: string; impact: string }>;
  /** Approved review ids this one is gated by. */
  dependsOn: string[];
  /** True once the approved ADR has been logged to the knowledge base. */
  kbSynced: boolean;
  openQuestions: number;
  signoffs: DesignSignoff[];
  postCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DesignThread extends DesignReview {
  posts: DesignPost[];
  /** Reviews that list THIS one in dependsOn — what an approval unlocks. */
  gates: Array<{ id: string; title: string; status: DesignStatus }>;
}

// ─── Pure decision rules (unit-tested) ───────────────────────────────────────

export const APPROVALS_REQUIRED = 2;

/**
 * May this review be approved right now? The ADR contract: a decision post
 * must exist, no question may still be open, and every review it depends on
 * must itself be approved — an unapproved dependency is a gate, and the deny
 * names it so the thread can link there.
 */
export function decideApproval(
  review: Pick<DesignReview, 'status' | 'openQuestions' | 'dependsOn'>,
  hasDecisionPost: boolean,
  dependencyStatuses: Map<string, DesignStatus>,
): { ok: true } | { ok: false; reason: string; blockingId?: string } {
  if (review.status === 'approved') return { ok: false, reason: 'already approved' };
  if (review.status === 'superseded') return { ok: false, reason: 'superseded — sign off on its successor instead' };
  if (!hasDecisionPost) return { ok: false, reason: 'no decision post yet — the thread has not converged' };
  if (review.openQuestions > 0) {
    return { ok: false, reason: `${review.openQuestions} question${review.openQuestions === 1 ? '' : 's'} still open — answer them first` };
  }
  for (const dep of review.dependsOn) {
    if (dependencyStatuses.get(dep) !== 'approved') {
      return { ok: false, reason: 'gated by an unapproved design', blockingId: dep };
    }
  }
  return { ok: true };
}

/** One sign-off per person (latest wins); approved at N distinct approvals
 *  with zero standing rejections. */
export function tallySignoffs(signoffs: DesignSignoff[]): {
  approvals: number; rejections: number; approved: boolean;
} {
  const latest = new Map<string, DesignSignoff>();
  for (const s of signoffs) latest.set(s.personName, s);
  let approvals = 0, rejections = 0;
  for (const s of latest.values()) {
    if (s.decision === 'approve') approvals++; else rejections++;
  }
  return { approvals, rejections, approved: rejections === 0 && approvals >= APPROVALS_REQUIRED };
}

// ─── Mock state ──────────────────────────────────────────────────────────────
//
// The rows live in src/mock/design-reviews.ts, on the fixture floor: timestamps
// resolve when the fixture is first read rather than when this module loaded,
// and `empty` is reachable through the mock control plane instead of by
// deleting rows out of shared state.
//
// `rows()` hands back the LIVE array, so answering a question and signing off
// still mutate what the next GET returns — the loop is walkable offline, and
// `POST /api/__mock/reset` puts the seed back.

let postSeq = 100;

const docs = (): DesignReviewDoc[] => designReviewDocs.rows();

/** A post created during a session, as opposed to a seeded one. */
function newPost(
  over: Partial<DesignPost> & Pick<DesignPost, 'authorKind' | 'authorName' | 'kind' | 'body'>,
): DesignPost {
  return {
    id: `dp-${++postSeq}`, resolvedBy: null, artifact: null,
    createdAt: new Date().toISOString(), ...over,
  };
}

// ─── Provider ────────────────────────────────────────────────────────────────

function openQuestions(doc: DesignReviewDoc): number {
  return doc.posts.filter((p) => p.kind === 'question' && p.resolvedBy == null).length;
}

function toReview(doc: DesignReviewDoc): DesignReview {
  return {
    id: doc.id, orgProjectId: doc.orgProjectId, orgProjectName: doc.orgProjectName,
    title: doc.title, status: doc.status, dependsOn: doc.dependsOn,
    summary: doc.summary, affected: doc.affected,
    kbSynced: doc.kbSynced, openQuestions: openQuestions(doc),
    signoffs: doc.signoffs, postCount: doc.posts.length,
    createdAt: doc.createdAt, updatedAt: doc.updatedAt,
  };
}

export async function listDesignReviews(opts: { orgProjectId?: string; status?: string } = {}): Promise<DesignReview[]> {
  // Aurora path: schema/design_reviews_schema.sql — not yet wired; mock-first
  // like the rest of the Design phase. void config to keep the shape honest.
  void config;
  let matching = docs().slice();
  if (opts.orgProjectId) matching = matching.filter((d) => d.orgProjectId === opts.orgProjectId);
  if (opts.status) matching = matching.filter((d) => d.status === opts.status);
  return matching
    .map(toReview)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getDesignThread(id: string): Promise<DesignThread | null> {
  const doc = docs().find((d) => d.id === id);
  if (!doc) return null;
  const gates = docs()
    .filter((d) => d.dependsOn.includes(id))
    .map((d) => ({ id: d.id, title: d.title, status: d.status }));
  return { ...toReview(doc), posts: doc.posts, gates };
}

/**
 * A person answers an open agent question. The loop then CONTINUES: the agent
 * that asked posts a revision incorporating the answer, and — once nothing is
 * open — the thread advances to `proposed`, ready for sign-off. In the mock
 * the revision is synchronous; on Aurora it will be an enqueued agent job.
 */
export async function answerQuestion(
  id: string, questionPostId: string, body: string, byName: string,
): Promise<DesignThread | null> {
  const doc = docs().find((d) => d.id === id);
  if (!doc) return null;
  const q = doc.posts.find((p) => p.id === questionPostId && p.kind === 'question');
  if (!q || q.resolvedBy != null) return null;

  const answer = newPost({
    authorKind: 'human', authorName: byName, kind: 'answer', body,
    createdAt: new Date().toISOString(),
  });
  q.resolvedBy = answer.id;
  doc.posts.push(answer);

  // The agent keeps going: it folds the answer into a revision.
  doc.posts.push(newPost({
    authorKind: q.authorKind, authorName: q.authorName, kind: 'revision',
    createdAt: new Date().toISOString(),
    body: `Revised with the answer above: ${body.length > 120 ? body.slice(0, 117) + '…' : body} — plan updated accordingly. Ready for a decision once the stewards agree.`,
  }));
  if (openQuestions(doc) === 0) {
    doc.posts.push(newPost({
      authorKind: q.authorKind, authorName: q.authorName, kind: 'decision',
      createdAt: new Date().toISOString(),
      body: 'Decision proposed on the basis of the resolved questions above. Sign-offs from two stewards approve it and log it to the knowledge base.',
    }));
    doc.status = 'proposed';
    // The summary is agent-MAINTAINED, not agent-written-once: a reader lands
    // on the summary first, and "Blocked on one intent question" after the
    // question was answered is the summary lying about the thread below it.
    const stem = doc.summary.split(/ Blocked on /)[0] ?? doc.summary;
    const gist = body.length > 140 ? `${body.slice(0, 137)}…` : body;
    doc.summary = `${stem.replace(/\s+$/, '')} Intent resolved by ${byName}: ${gist}`;
  }
  doc.updatedAt = new Date().toISOString();
  return getDesignThread(id);
}

/**
 * Record a sign-off. Approval is gated by decideApproval (decision post, no
 * open questions, dependencies approved); at quorum the review becomes an
 * approved ADR and is logged to the knowledge base.
 */
export async function signoffDesign(
  id: string, decision: 'approve' | 'reject', byName: string, role: string,
): Promise<{ thread: DesignThread; error?: never } | { thread?: never; error: string; blockingId?: string } | null> {
  const doc = docs().find((d) => d.id === id);
  if (!doc) return null;

  if (decision === 'approve') {
    const gate = decideApproval(
      { status: doc.status, openQuestions: openQuestions(doc), dependsOn: doc.dependsOn },
      doc.posts.some((p) => p.kind === 'decision'),
      new Map(docs().map((d) => [d.id, d.status])),
    );
    if (!gate.ok) return { error: gate.reason, ...(gate.blockingId ? { blockingId: gate.blockingId } : {}) };
  }

  doc.signoffs = doc.signoffs.filter((s) => s.personName !== byName);
  doc.signoffs.push({ personName: byName, role, decision, at: new Date().toISOString() });

  const tally = tallySignoffs(doc.signoffs);
  if (decision === 'reject') {
    doc.status = 'rejected';
  } else if (tally.approved) {
    doc.status = 'approved';
    // The ADR is logged: on Aurora this writes a documents row + KB sync job;
    // the mock flips the flag the thread displays.
    doc.kbSynced = true;
  }
  doc.updatedAt = new Date().toISOString();
  const thread = await getDesignThread(id);
  // An approval makes the design a searchable decision (lib/search-index); any signoff may change its status.
  await noteSearchWrite({ type: 'decision', id });
  return thread ? { thread } : null;
}
