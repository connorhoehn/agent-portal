// Types for the Knowledge Explorer (Workspace / Enterprise / Rules / Prompts).
//
// Ported from agentic-assessment-accelerator's
// ui/src/components/knowledge/types.ts, plus the subset of
// ui/src/components/confluence/types.ts the explorer itself reads
// (ActivityRun, CommentListItem, TreeNode) — see docs/assessment-tenant.md
// "The two layouts worth keeping -> Workspace page" and the source repo's
// docs/knowledge-library.md for the contract this mirrors. Node ids stay
// namespaced exactly as the source defines them: `ec:` (enterprise-context
// relative path), `prompt:` (filename under .claude/commands/), `rule:`
// (`rule:CLAUDE.md`, the one guardrail doc), `page:` (a synced page id).
//
// Routes: GET /api/assessment/knowledge/tree, GET/PUT
// /api/assessment/knowledge/doc, GET /api/assessment/knowledge/doc/versions,
// POST /api/assessment/knowledge/doc/restore, POST
// /api/assessment/knowledge/presence (enter/heartbeat/leave — see DocPane).

export type KnowledgeSectionKind = 'local' | 'synced';

export interface KnowledgeNode {
  id: string;
  title: string;
  parent_id: string | null;
  is_dir: boolean;
  classification?: string;
  /** Present (and false) for local doc nodes writable via PUT
   *  /knowledge/doc; absent/irrelevant for synced `page:` nodes. */
  editable?: boolean;
  /** False for hidden non-markdown binaries — listed but not renderable.
   *  Absent implies true. */
  viewable?: boolean;
  updated_at?: string;
  /** Raw synced-page id, present only on `page:` nodes in a synced section. */
  page_id?: string;
}

export interface KnowledgeSection {
  key: string;
  title: string;
  kind: KnowledgeSectionKind;
  provider?: string;
  /** When this synced section last pulled; absent for a local section. */
  last_pulled_at?: string;
  nodes: KnowledgeNode[];
}

export interface KnowledgeTreeResponse {
  sections: KnowledgeSection[];
}

export interface KnowledgeDoc {
  id: string;
  title: string;
  classification: string;
  markdown: string;
  editable: boolean;
  path: string;
  updated_at: string;
  /** `prompt:` docs only — the slash command's `argument-hint:` frontmatter
   *  key, surfaced as a first-class field rather than left buried in the
   *  frontmatter block the display view strips (see
   *  knowledgeFormat.stripFrontmatter). Absent for every other classification. */
  argument_hint?: string;
}

export interface KnowledgeDocPutRequest {
  id: string;
  markdown: string;
  label?: string | null;
}

export interface KnowledgeDocPutResponse {
  ok: boolean;
  updated_at: string;
}

// ─── Version history (GET .../doc/versions, POST .../doc/restore) ──────────

export interface KnowledgeDocVersionSummary {
  stamp: string;
  label: string | null;
  size: number;
  saved_at: string;
}

export interface KnowledgeDocVersionsResponse {
  versions: KnowledgeDocVersionSummary[];
}

export interface KnowledgeDocVersion {
  markdown: string;
  stamp: string;
  label: string | null;
}

// ─── Subset of confluence/types.ts the explorer's Views block + activity
// bar read. Kept as a thin, source-faithful mirror even though this port's
// domain model (docs/assessment-tenant.md) has no Comment entity of its
// own — see knowledgeFormat.ts for how KnowledgeExplorer uses these. ──────

export type ActivityRunStatus = 'running' | 'completed' | 'failed';

export interface ActivityRun {
  id: string;
  command: string;
  status: ActivityRunStatus;
  started_at: string;
  finished_at: string | null;
  summary: string;
}

export type CommentKind = 'inline' | 'footer';
export type CommentStatus = 'open' | 'resolved' | 'dangling' | 'deleted';

export interface CommentListItem {
  comment_id: string;
  page_id: string;
  kind: CommentKind;
  status: CommentStatus;
  body_markdown: string;
  author_display: string;
  created_at: string;
  version: number;
  parent_comment_id: string | null;
  first_seen_at: string;
  jira_key: string | null;
  page_title: string;
  jira_url?: string | null;
  is_new?: boolean;
}

/** The synced-space tree shape, namespaced by raw page id rather than the
 *  knowledge node id — kept for parity with the source's confluence
 *  TreeNode. KnowledgeExplorer itself only ever walks KnowledgeNode. */
export interface TreeNode {
  page_id: string;
  title: string;
  parent_id: string | null;
  slug_path: string;
  position: number;
  has_children: boolean;
  version: number;
}

// ─── This port's four Informatics surfaces ──────────────────────────────────

export type KnowledgeMode = 'workspace' | 'enterprise' | 'rules' | 'prompts';

// ─── Realtime — wire shape of GET /api/assessment/events ───────────────────
//
// Mirrors middleware/src/lib/assessment-broker.ts's AssessmentEvent union
// exactly (server and portal are separate compilation units — no shared
// package — so this is a deliberate duplicate of that contract, same as
// portal/src/components/canary/types.ts mirrors canary-types.ts). Each
// event arrives as one SSE `data:` frame; the frame's `id:` line (this
// broker's monotonic seq) is what powers the browser's native
// Last-Event-ID reconnect — see knowledge/useAssessmentEvents.ts.

export interface PresenceViewer {
  sub: string;
  name: string;
  tab_id: string;
  since: string;
}

export type AssessmentSSEEvent =
  | { type: 'knowledge.pulled'; section: string; pages: number; files_pulled: number; ts: string }
  | { type: 'knowledge.published'; id: string; page_id: string; version: number; ts: string }
  | { type: 'knowledge.doc.saved'; id: string; stamp: string; by: string; ts: string }
  | { type: 'knowledge.comment.created'; id: string; doc_id: string; by: string; body: string; ts: string }
  | { type: 'knowledge.presence'; doc_id: string; viewers: PresenceViewer[]; ts: string }
  | { type: 'run.started'; run_id: string; command: string; team_id: string | null; ts: string }
  | { type: 'run.progress'; run_id: string; command: string; team_id: string | null; percent: number; ts: string }
  | { type: 'run.completed'; run_id: string; command: string; team_id: string | null; summary: string; ts: string }
  | { type: 'run.failed'; run_id: string; command: string; team_id: string | null; reason: string; ts: string }
  // Synthesized server-side for a single reconnecting client when its
  // Last-Event-ID predates the broker's ring buffer retention — some events
  // between what it last saw and now are gone for good. Never appears in
  // another client's stream. See middleware/src/lib/assessment-broker.ts's
  // `gapFrameFor` / `StreamGapEvent`.
  | { type: 'stream.gap'; ts: string };
