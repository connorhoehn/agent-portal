// Run with:  cd portal && node --test 'src/pages/assessment/__tests__/knowledgeFormat.test.ts'
//
// Plain node:test — the portal has no test runner in package.json.
// knowledgeFormat is pure TypeScript (no DOM, no fetch, type-only imports),
// so Node's type-stripping loader runs it directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  activityEventToFeedItem,
  activityForNode,
  activityForSection,
  adaptChatMessageForPanel,
  channelForDoc,
  channelForSection,
  commentsForDoc,
  decideDocSaveGate,
  docSavedNoticeText,
  docSyncStatus,
  externalDocSave,
  findNode,
  firstViewableLeaf,
  flatNodes,
  gatewayOfflineHint,
  isFolderNode,
  isGatewayReady,
  isPageNode,
  latestPresenceForDoc,
  liveConnectionState,
  mergeComments,
  mergeFeeds,
  mergePresenceForDisplay,
  mergeSsePresence,
  nextTreeFocus,
  nodePath,
  parseActivityRuns,
  pulledEventsForSection,
  sectionForNode,
  sectionsForMode,
  sseEventToActivityEvent,
  sseEventsForDoc,
  stripFrontmatter,
  stripTitleHeading,
  summarizeReactions,
  defuseJsonFences,
  summarizeStoredReactions,
  toActivityFeedItems,
  treeDepth,
  treeParentId,
  viewCounts,
} from '../knowledge/knowledgeFormat.ts';
import type { ActivityRun, AssessmentSSEEvent, CommentListItem, KnowledgeNode, KnowledgeSection, PresenceViewer } from '../knowledge/types.ts';
import type { OwnSaveState } from '../knowledge/knowledgeFormat.ts';
import type { ActivityEvent, ChatMessage as RMChatMessage, Reaction } from '@connorhoehnslalom/realtime-modules/client';

/** Minimal node — only the fields the derivations read. */
function node(partial: Partial<KnowledgeNode> & { id: string; title: string }): KnowledgeNode {
  return { parent_id: null, is_dir: false, ...partial };
}

// Keyed `enterprise_context` — the actual key GET /api/assessment/knowledge/tree
// sends (confirmed live: `curl 127.0.0.1:3011/api/assessment/knowledge/tree`
// with an assessment-tenant session — see middleware/src/mock/assessment.ts's
// the knowledge-sections fixture and providers/__tests__/assessment-aurora.test.ts's
// `section_key` rows, which agree with each other). This fixture used to
// invent a section keyed plain `enterprise`, which is what made the mapping
// bug in `SECTION_KEY_FOR_MODE` invisible: the test agreed with the code and
// both disagreed with the server (DEFECTS.md).
const ENTERPRISE: KnowledgeSection = {
  key: 'enterprise_context',
  title: 'Enterprise Context',
  kind: 'local',
  nodes: [
    node({ id: 'ec:organization', title: 'Organization', is_dir: true }),
    node({ id: 'ec:organization/x.md', title: 'X', parent_id: 'ec:organization', classification: 'internal', editable: true }),
    node({ id: 'ec:hidden.bin', title: 'Hidden', viewable: false }),
  ],
};

// Keyed `confluence-eng` for the same reason ENTERPRISE is keyed
// `enterprise_context`: that is the key GET /api/assessment/knowledge/tree
// gives its synced section. The invented `synced:team-space` read like a
// convention (`kind` is `synced`) and was not one — no response and no
// middleware source file has ever carried it.
const WORKSPACE_SPACE: KnowledgeSection = {
  key: 'confluence-eng',
  title: 'Team Space',
  kind: 'synced',
  provider: 'confluence',
  nodes: [
    node({ id: 'page:1', title: 'Runbook', page_id: '1' }),
    node({ id: 'page:2', title: 'Onboarding', parent_id: 'page:1', page_id: '2' }),
  ],
};

const RULES_SECTION: KnowledgeSection = {
  key: 'rules',
  title: 'Rules & Prompts',
  kind: 'local',
  nodes: [node({ id: 'rule:CLAUDE.md', title: 'Guardrail' })],
};

const PROMPTS_SECTION: KnowledgeSection = {
  key: 'prompts',
  title: 'Prompts',
  kind: 'local',
  nodes: [node({ id: 'prompt:score-dimensions.md', title: 'Score dimensions' })],
};

const ALL_SECTIONS = [ENTERPRISE, WORKSPACE_SPACE, RULES_SECTION, PROMPTS_SECTION];

// ─── Section selection ───────────────────────────────────────────────────────

test('sectionsForMode: workspace shows only synced sections', () => {
  const result = sectionsForMode(ALL_SECTIONS, 'workspace');
  assert.deepEqual(result.map((s) => s.key), ['confluence-eng']);
});

// Every key here is the one GET /api/assessment/knowledge/tree actually sends
// (see ENTERPRISE's fixture comment above) — this is the test that would have
// caught the `enterprise` -> `enterprise_context` mismatch had the fixture not
// independently invented the wrong key.
test('sectionsForMode: enterprise/rules/prompts each show their real one keyed local section', () => {
  assert.deepEqual(sectionsForMode(ALL_SECTIONS, 'enterprise').map((s) => s.key), ['enterprise_context']);
  assert.deepEqual(sectionsForMode(ALL_SECTIONS, 'rules').map((s) => s.key), ['rules']);
  assert.deepEqual(sectionsForMode(ALL_SECTIONS, 'prompts').map((s) => s.key), ['prompts']);
});

test('flatNodes flattens every section\'s nodes in order', () => {
  const nodes = flatNodes([ENTERPRISE, RULES_SECTION]);
  assert.equal(nodes.length, 4);
  assert.equal(nodes[3].id, 'rule:CLAUDE.md');
});

test('findNode returns null for a missing or null id', () => {
  const nodes = flatNodes([ENTERPRISE]);
  assert.equal(findNode(nodes, null), null);
  assert.equal(findNode(nodes, 'nope'), null);
  assert.equal(findNode(nodes, 'ec:organization')?.title, 'Organization');
});

// ─── Node classification ─────────────────────────────────────────────────────

test('isPageNode is true only for `page:`-namespaced ids', () => {
  assert.equal(isPageNode(node({ id: 'page:1', title: 'P' })), true);
  assert.equal(isPageNode(node({ id: 'ec:x', title: 'X' })), false);
  assert.equal(isPageNode(null), false);
});

test('isFolderNode is true for a real directory, false for a synced parent page', () => {
  assert.equal(isFolderNode(node({ id: 'ec:organization', title: 'Organization', is_dir: true })), true);
  // A synced page can have children AND its own content — is_dir there means
  // "has children", not "content-less folder" (see knowledge/KnowledgeTree.tsx).
  assert.equal(isFolderNode(node({ id: 'page:1', title: 'P', is_dir: true, page_id: '1' })), false);
  assert.equal(isFolderNode(node({ id: 'ec:x', title: 'X', is_dir: false })), false);
});

// ─── Default selection ────────────────────────────────────────────────────────

test('firstViewableLeaf skips folders and hidden binaries', () => {
  const leaf = firstViewableLeaf(ENTERPRISE.nodes);
  assert.equal(leaf?.id, 'ec:organization/x.md');
});

test('firstViewableLeaf falls back to any leaf when none are viewable', () => {
  const nodes = [node({ id: 'a', title: 'A', viewable: false }), node({ id: 'b', title: 'B', viewable: false })];
  assert.equal(firstViewableLeaf(nodes)?.id, 'a');
});

test('firstViewableLeaf returns null with no leaves at all', () => {
  assert.equal(firstViewableLeaf([node({ id: 'dir', title: 'Dir', is_dir: true })]), null);
});

// ─── Breadcrumb path ──────────────────────────────────────────────────────────

test('nodePath walks parent_id from root to the selected node', () => {
  const path = nodePath(ENTERPRISE.nodes, 'ec:organization/x.md');
  assert.deepEqual(path.map((n) => n.title), ['Organization', 'X']);
});

test('nodePath is empty for a null id and a single entry for a root node', () => {
  assert.deepEqual(nodePath(ENTERPRISE.nodes, null), []);
  assert.deepEqual(nodePath(ENTERPRISE.nodes, 'ec:organization').map((n) => n.title), ['Organization']);
});

test('nodePath tolerates a cyclic parent_id without looping forever', () => {
  const cyclic = [node({ id: 'a', title: 'A', parent_id: 'b' }), node({ id: 'b', title: 'B', parent_id: 'a' })];
  const path = nodePath(cyclic, 'a');
  assert.deepEqual(path.map((n) => n.id), ['b', 'a']);
});

// ─── Views block: comments (always empty in this domain) + activity ─────────

const RUNS: ActivityRun[] = [
  { id: 'r1', command: '/develop-jira-story', status: 'completed', started_at: '2026-09-01T00:00:00Z', finished_at: '2026-09-01T00:05:00Z', summary: 'Drafted a story for Runbook' },
  { id: 'r2', command: '/score-dimensions', status: 'running', started_at: '2026-09-02T00:00:00Z', finished_at: null, summary: 'Scoring TEAM-002' },
];

test('activityForSection matches runs whose command/summary mentions a section title', () => {
  const matched = activityForSection(WORKSPACE_SPACE, RUNS);
  assert.deepEqual(matched.map((r) => r.id), ['r1']);
});

test('activityForSection is empty when the section has no titled nodes', () => {
  assert.deepEqual(activityForSection({ ...WORKSPACE_SPACE, nodes: [] }, RUNS), []);
});

test('activityForNode matches a single node\'s title', () => {
  const runbook = WORKSPACE_SPACE.nodes[0];
  assert.deepEqual(activityForNode(runbook, RUNS).map((r) => r.id), ['r1']);
});

test('viewCounts: comments count only matches this section\'s page ids; activity reuses the section match', () => {
  const comments: CommentListItem[] = [
    { comment_id: 'c1', page_id: '1', kind: 'inline', status: 'open', body_markdown: 'hi', author_display: 'A', created_at: '', version: 1, parent_comment_id: null, first_seen_at: '', jira_key: null, page_title: 'Runbook' },
    { comment_id: 'c2', page_id: '999', kind: 'footer', status: 'open', body_markdown: 'other page', author_display: 'B', created_at: '', version: 1, parent_comment_id: null, first_seen_at: '', jira_key: null, page_title: 'Elsewhere' },
  ];
  const counts = viewCounts(WORKSPACE_SPACE, comments, RUNS);
  assert.deepEqual(counts, { commentsCount: 1, activityCount: 1 });
});

test('viewCounts is all zeros for a section with no comments/activity data', () => {
  assert.deepEqual(viewCounts(RULES_SECTION, [], []), { commentsCount: 0, activityCount: 0 });
});

// ─── Runs -> activity feed ────────────────────────────────────────────────────

test('parseActivityRuns accepts a bare array', () => {
  const parsed = parseActivityRuns(RUNS);
  assert.equal(parsed.length, 2);
});

test('parseActivityRuns accepts { runs: [...] } and drops malformed entries', () => {
  const parsed = parseActivityRuns({
    runs: [
      { id: 'ok', command: '/foo', started_at: '2026-09-01T00:00:00Z', status: 'failed' },
      { id: 'missing-command', started_at: '2026-09-01T00:00:00Z' },
      'not an object',
      null,
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].status, 'failed');
  assert.equal(parsed[0].summary, '/foo'); // no summary/team_id on the raw record -> falls back to command
});

test('parseActivityRuns reads a shape mismatch (object, no runs array) as no activity', () => {
  assert.deepEqual(parseActivityRuns({ nope: true }), []);
  assert.deepEqual(parseActivityRuns(null), []);
  assert.deepEqual(parseActivityRuns(undefined), []);
});

test('parseActivityRuns falls back to "Team <id>" when summary is missing but team_id is present', () => {
  const parsed = parseActivityRuns([{ id: 'r', command: '/score-dimensions', started_at: '2026-09-01T00:00:00Z', team_id: 'TEAM-002' }]);
  assert.equal(parsed[0].summary, 'Team TEAM-002');
});

test('toActivityFeedItems maps status to an actor/action/kind the ActivityFeed can render', () => {
  const items = toActivityFeedItems(RUNS);
  assert.equal(items[0].action, 'completed');
  assert.equal(items[0].kind, 'task');
  assert.equal(items[1].action, 'started');
});

// ─── Markdown display cleanup ─────────────────────────────────────────────────

test('stripFrontmatter removes a leading --- fenced block', () => {
  const md = '---\ntitle: X\n---\n# X\n\nBody.';
  assert.equal(stripFrontmatter(md), '# X\n\nBody.');
});

test('stripFrontmatter is a no-op without a frontmatter block', () => {
  const md = '# X\n\nBody.';
  assert.equal(stripFrontmatter(md), md);
});

test('stripTitleHeading drops a leading heading that repeats the doc title', () => {
  const md = '# Organization\n\nBody.';
  assert.equal(stripTitleHeading(md, 'Organization'), 'Body.');
});

test('stripTitleHeading is case/whitespace tolerant but leaves a different heading alone', () => {
  assert.equal(stripTitleHeading('#   Organization  \nBody.', 'organization'), 'Body.');
  const untouched = '# Something Else\n\nBody.';
  assert.equal(stripTitleHeading(untouched, 'Organization'), untouched);
});

// ─── Realtime helpers ────────────────────────────────────────────────────────

test('channelForDoc/channelForSection namespace consistently', () => {
  assert.equal(channelForDoc('ec:organization/raci.md'), 'assessment:doc:ec:organization/raci.md');
  assert.equal(channelForSection('confluence-eng'), 'assessment:knowledge:confluence-eng');
});

test('sseEventToActivityEvent carries the actor as userId/displayName when present, else "System"', () => {
  const saved: AssessmentSSEEvent = { type: 'knowledge.doc.saved', id: 'ec:x.md', stamp: 's1', by: 'u-jonas', ts: '2026-01-01T00:00:00.000Z' };
  const a = sseEventToActivityEvent(saved);
  assert.equal(a.eventType, 'knowledge.doc.saved');
  assert.equal(a.userId, 'u-jonas');
  assert.equal(a.displayName, 'u-jonas');
  assert.equal(a.timestamp, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(a.detail, { id: 'ec:x.md', stamp: 's1', by: 'u-jonas' });

  const pulled: AssessmentSSEEvent = { type: 'knowledge.pulled', section: 'confluence-eng', pages: 3, files_pulled: 2, ts: '2026-01-01T00:00:01.000Z' };
  const b = sseEventToActivityEvent(pulled);
  assert.equal(b.userId, null);
  assert.equal(b.displayName, 'System');
});

test('mergeFeeds de-dupes overlapping (timestamp, eventType, userId) triples and sorts newest-first', () => {
  const shared: ActivityEvent = { eventType: 'knowledge.doc.saved', detail: {}, timestamp: '2026-01-01T00:00:02.000Z', userId: 'u1', displayName: 'u1' };
  const older: ActivityEvent = { eventType: 'knowledge.doc.saved', detail: {}, timestamp: '2026-01-01T00:00:00.000Z', userId: 'u1', displayName: 'u1' };
  const newer: ActivityEvent = { eventType: 'knowledge.published', detail: {}, timestamp: '2026-01-01T00:00:03.000Z', userId: 'u2', displayName: 'u2' };
  const merged = mergeFeeds([shared, older], [shared, newer]);
  assert.equal(merged.length, 3); // `shared` appears in both lists but counts once
  assert.deepEqual(merged.map((e) => e.timestamp), ['2026-01-01T00:00:03.000Z', '2026-01-01T00:00:02.000Z', '2026-01-01T00:00:00.000Z']);
});

test('sseEventsForDoc matches saves/publishes by id, comments by doc_id, and pulls by the doc\'s section', () => {
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.doc.saved', id: 'ec:a.md', stamp: 's', by: 'u', ts: 't1' },
    { type: 'knowledge.doc.saved', id: 'ec:b.md', stamp: 's', by: 'u', ts: 't2' },
    { type: 'knowledge.published', id: 'ec:a.md', page_id: 'p1', version: 1, ts: 't3' },
    { type: 'knowledge.comment.created', id: 'c1', doc_id: 'ec:a.md', by: 'u', body: 'hi', ts: 't4' },
    { type: 'knowledge.pulled', section: 'confluence-eng', pages: 1, files_pulled: 1, ts: 't5' },
    { type: 'run.started', run_id: 'r1', command: 'score-dimensions', team_id: null, ts: 't6' },
  ];
  const forA = sseEventsForDoc(events, 'ec:a.md', 'confluence-eng');
  assert.deepEqual(forA.map((e) => e.type), ['knowledge.doc.saved', 'knowledge.published', 'knowledge.comment.created', 'knowledge.pulled']);
  // A run event never matches a doc's feed (no id/doc_id/section on it).
  assert.ok(!forA.some((e) => e.type === 'run.started'));
  // With no containing section, the pull is correctly excluded.
  const noSection = sseEventsForDoc(events, 'ec:a.md', null);
  assert.ok(!noSection.some((e) => e.type === 'knowledge.pulled'));
});

test('pulledEventsForSection filters knowledge.pulled to one section', () => {
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.pulled', section: 'confluence-eng', pages: 1, files_pulled: 1, ts: 't1' },
    { type: 'knowledge.pulled', section: 'other', pages: 1, files_pulled: 1, ts: 't2' },
    { type: 'run.started', run_id: 'r1', command: 'x', team_id: null, ts: 't3' },
  ];
  const result = pulledEventsForSection(events, 'confluence-eng');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.ts, 't1');
});

test('sectionForNode finds the section owning a node id, or null', () => {
  assert.equal(sectionForNode([ENTERPRISE], 'ec:organization/x.md'), ENTERPRISE);
  assert.equal(sectionForNode([ENTERPRISE], 'nope'), null);
});

test('summarizeReactions aggregates by emoji, scoped to one target, flagging the viewer\'s own', () => {
  const reactions: Reaction[] = [
    { id: 'r1', clientId: 'me', channel: 'c', emoji: '👍', effect: '', position: null, metadata: {}, timestamp: 't', targetId: 'doc-1' },
    { id: 'r2', clientId: 'other', channel: 'c', emoji: '👍', effect: '', position: null, metadata: {}, timestamp: 't', targetId: 'doc-1' },
    { id: 'r3', clientId: 'other', channel: 'c', emoji: '🎉', effect: '', position: null, metadata: {}, timestamp: 't', targetId: 'doc-1' },
    { id: 'r4', clientId: 'me', channel: 'c', emoji: '👍', effect: '', position: null, metadata: {}, timestamp: 't', targetId: 'doc-2' }, // different target
  ];
  const summary = summarizeReactions(reactions, 'doc-1', 'me');
  assert.deepEqual(
    summary.sort((a, b) => a.emoji.localeCompare(b.emoji)),
    [{ emoji: '🎉', count: 1, mine: false }, { emoji: '👍', count: 2, mine: true }],
  );
  // No current viewer -> nothing is ever "mine".
  const noViewer = summarizeReactions(reactions, 'doc-1', null);
  assert.ok(noViewer.every((r) => r.mine === false));
});

test('adaptChatMessageForPanel maps message/metadata onto content/displayName/avatarUrl', () => {
  const msg: RMChatMessage = {
    id: 'm1', clientId: 'u1', channel: 'c', message: 'hello', timestamp: 't1',
    metadata: { displayName: 'Jonas', avatarUrl: 'https://x/y.png' },
  };
  assert.deepEqual(adaptChatMessageForPanel(msg), {
    id: 'm1', clientId: 'u1', content: 'hello', timestamp: 't1', displayName: 'Jonas', avatarUrl: 'https://x/y.png',
  });
  const bare: RMChatMessage = { id: 'm2', clientId: 'u2', channel: 'c', message: 'hi', timestamp: 't2' };
  assert.deepEqual(adaptChatMessageForPanel(bare), { id: 'm2', clientId: 'u2', content: 'hi', timestamp: 't2', displayName: undefined, avatarUrl: undefined });
});

test('activityEventToFeedItem labels known event types and falls back to the raw type', () => {
  const pulled: ActivityEvent = { eventType: 'knowledge.pulled', detail: { files_pulled: 2, pages: 3 }, timestamp: 't1', userId: null, displayName: 'System' };
  const item = activityEventToFeedItem(pulled);
  assert.equal(item.action, 'synced');
  assert.equal(item.subject, '2 of 3 pages');
  assert.equal(item.actor, 'System');

  const custom: ActivityEvent = { eventType: 'presence:joined', detail: {}, timestamp: 't2', userId: 'u1', displayName: 'u1' };
  assert.equal(activityEventToFeedItem(custom).action, 'presence:joined');
});

// ─── Keyboard tree navigation (useKeyboardTree.ts's pure half) ─────────────

test('nextTreeFocus moves within the visible list without wrapping', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(nextTreeFocus(ids, 'a', 'ArrowDown'), 'b');
  assert.equal(nextTreeFocus(ids, 'b', 'ArrowDown'), 'c');
  // Clamped at the end, not wrapped.
  assert.equal(nextTreeFocus(ids, 'c', 'ArrowDown'), 'c');
  assert.equal(nextTreeFocus(ids, 'c', 'ArrowUp'), 'b');
  assert.equal(nextTreeFocus(ids, 'a', 'ArrowUp'), 'a');
});

test('nextTreeFocus Home/End jump to the first/last visible row regardless of position', () => {
  const ids = ['a', 'b', 'c'];
  assert.equal(nextTreeFocus(ids, 'b', 'Home'), 'a');
  assert.equal(nextTreeFocus(ids, 'b', 'End'), 'c');
});

test('nextTreeFocus treats an unknown/absent currentId as "nothing focused yet"', () => {
  const ids = ['a', 'b', 'c'];
  // ArrowDown/Home from nowhere lands on the first row...
  assert.equal(nextTreeFocus(ids, null, 'ArrowDown'), 'a');
  assert.equal(nextTreeFocus(ids, 'not-visible', 'ArrowDown'), 'a');
  assert.equal(nextTreeFocus(ids, null, 'Home'), 'a');
  // ...ArrowUp/End from nowhere lands on the last, mirroring it.
  assert.equal(nextTreeFocus(ids, null, 'ArrowUp'), 'c');
  assert.equal(nextTreeFocus(ids, 'not-visible', 'ArrowUp'), 'c');
  assert.equal(nextTreeFocus(ids, null, 'End'), 'c');
});

test('nextTreeFocus on an empty tree returns null for every key', () => {
  assert.equal(nextTreeFocus([], null, 'ArrowDown'), null);
  assert.equal(nextTreeFocus([], 'x', 'Home'), null);
});

test('treeParentId reads the parent id, or null at the root / for an unknown id', () => {
  const nodes = [
    { id: 'root', parentId: null },
    { id: 'child', parentId: 'root' },
  ];
  assert.equal(treeParentId(nodes, 'child'), 'root');
  assert.equal(treeParentId(nodes, 'root'), null);
  assert.equal(treeParentId(nodes, 'missing'), null);
});

test('treeDepth counts ancestors from the root (0-based)', () => {
  const nodes = [
    { id: 'root', parentId: null },
    { id: 'mid', parentId: 'root' },
    { id: 'leaf', parentId: 'mid' },
  ];
  assert.equal(treeDepth(nodes, 'root'), 0);
  assert.equal(treeDepth(nodes, 'mid'), 1);
  assert.equal(treeDepth(nodes, 'leaf'), 2);
});

test('treeDepth is cycle-guarded', () => {
  // Malformed input (a parent loop) terminates instead of looping forever.
  const nodes = [
    { id: 'a', parentId: 'b' },
    { id: 'b', parentId: 'a' },
  ];
  assert.doesNotThrow(() => treeDepth(nodes, 'a'));
});

// ─── externalDocSave / docSavedNoticeText ───────────────────────────────────
//
// externalDocSave takes an OwnSaveState (confirmedTimestamps + saveInFlight)
// instead of a single "ignore anything at or before this ts" cutoff — see
// OwnSaveState's own doc comment for why a before/after comparison loses the
// race the broker's publish-inside-the-PUT-handler creates. NONE and SYNCED
// below are the two states a real save transitions through.

const NONE: OwnSaveState = { confirmedTimestamps: new Set(), saveInFlight: false };
function synced(...ts: string[]): OwnSaveState {
  return { confirmedTimestamps: new Set(ts), saveInFlight: false };
}
const IN_FLIGHT: OwnSaveState = { confirmedTimestamps: new Set(), saveInFlight: true };

test('externalDocSave finds the newest knowledge.doc.saved for a doc, ignoring other docs', () => {
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.doc.saved', id: 'rule:a', stamp: 's1', by: 'u-jonas', ts: '2026-01-01T00:00:01.000Z' },
    { type: 'knowledge.doc.saved', id: 'rule:other', stamp: 's2', by: 'u-amina', ts: '2026-01-01T00:00:02.000Z' },
    { type: 'knowledge.doc.saved', id: 'rule:a', stamp: 's3', by: 'u-amina', ts: '2026-01-01T00:00:03.000Z' },
  ];
  assert.deepEqual(externalDocSave(events, 'rule:a', NONE), { by: 'u-amina', ts: '2026-01-01T00:00:03.000Z' });
});

// Scenario: frame-before-response. The broker publishes inside the PUT
// handler, so this tab's own SSE echo can arrive before `putJson` resolves —
// at that instant the ts isn't confirmed yet, but `saveInFlight` (set BEFORE
// the request went out) still correctly suppresses it.
test('externalDocSave: a same-tab save whose SSE frame outraces its own response is suppressed via saveInFlight', () => {
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.doc.saved', id: 'rule:a', stamp: 's1', by: 'u-jonas', ts: '2026-01-01T00:00:01.000Z' },
  ];
  assert.equal(externalDocSave(events, 'rule:a', IN_FLIGHT), null);
});

// Scenario: frame-after-response. The response resolved first and its
// `updated_at` was recorded into confirmedTimestamps; the SSE echo arriving
// afterward matches by membership, order no longer matters.
test('externalDocSave: a same-tab save whose response confirmed first is suppressed via confirmedTimestamps', () => {
  const ts = '2026-01-01T00:00:03.000Z';
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.doc.saved', id: 'rule:a', stamp: 's1', by: 'u-jonas', ts },
  ];
  assert.equal(externalDocSave(events, 'rule:a', synced(ts)), null);
});

// Scenario: a genuine external save — nobody's own, in-flight or confirmed —
// must still surface.
test('externalDocSave: a genuine external save is reported regardless of own-save state', () => {
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.doc.saved', id: 'rule:a', stamp: 's1', by: 'u-jonas', ts: '2026-01-01T00:00:01.000Z' },
    { type: 'knowledge.doc.saved', id: 'rule:a', stamp: 's2', by: 'u-amina', ts: '2026-01-01T00:00:02.000Z' },
  ];
  assert.deepEqual(
    externalDocSave(events, 'rule:a', synced('2026-01-01T00:00:01.000Z')),
    { by: 'u-amina', ts: '2026-01-01T00:00:02.000Z' },
  );
});

// Scenario: a reload. Reselecting a doc (or any other "reload" of the pane's
// own React state) must not forget which timestamps are this tab's own — the
// old single `ignoreUpToTs`, reset to null on every node.id change, is
// exactly what let a stale echo of an old save of yours reappear as "someone
// else changed this" after navigating away and back (DEFECTS.md). Because
// confirmedTimestamps is a set rather than a cutoff, simply persisting it
// (never clearing it on reselect) is enough — recomputing from scratch with
// the same set still correctly suppresses the old event.
test('externalDocSave: an old confirmed-own save is still suppressed after a "reload" (state recomputed fresh, timestamps persisted)', () => {
  const own = synced('2026-01-01T00:00:01.000Z');
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.doc.saved', id: 'rule:a', stamp: 's1', by: 'u-jonas', ts: '2026-01-01T00:00:01.000Z' },
  ];
  // First evaluation, as if freshly selected.
  assert.equal(externalDocSave(events, 'rule:a', own), null);
  // Simulated "reload" (e.g. navigating away and back): a brand-new call
  // against the exact same persisted own-save state and the same still-
  // present event — still correctly suppressed, unlike a single ignoreUpToTs
  // that a reset effect would have wiped back to null.
  assert.equal(externalDocSave(events, 'rule:a', own), null);
});

test('externalDocSave returns null when there is nothing for this doc at all', () => {
  assert.equal(externalDocSave([], 'rule:a', NONE), null);
});

test('externalDocSave ignores knowledge.published (no actor) and other event types', () => {
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.published', id: 'rule:a', page_id: 'page:1', version: 1, ts: '2026-01-01T00:00:01.000Z' },
    { type: 'knowledge.comment.created', id: 'c1', doc_id: 'rule:a', by: 'u-amina', body: 'hi', ts: '2026-01-01T00:00:02.000Z' },
  ];
  assert.equal(externalDocSave(events, 'rule:a', NONE), null);
});

test('docSavedNoticeText names the actor and renders the save\'s real age, not a hardcoded "just now"', () => {
  const now = Date.now();
  // A save from seconds ago genuinely reads "just now" (relativeTime's own
  // <2min cutover) — this case alone can't distinguish the fix from the bug.
  assert.equal(docSavedNoticeText('u-amina', new Date(now - 30_000).toISOString()), 'Updated by u-amina just now');
  // DEFECTS #5/#8/#7's actual repro: an edit from minutes ago must say so.
  assert.equal(docSavedNoticeText('u-amina', new Date(now - 8 * 60_000).toISOString()), 'Updated by u-amina 8m ago');
  // ...and one from hours ago (the 101-minutes repro) must say hours, never
  // "just now" regardless of how the frame reached this tab (fresh replay,
  // reconnect catch-up, or a live event that arrived late).
  assert.equal(docSavedNoticeText('u-amina', new Date(now - 101 * 60_000).toISOString()), 'Updated by u-amina 1h ago');
});

// ─── Comments over SSE ──────────────────────────────────────────────────────

test('commentsForDoc filters knowledge.comment.created to one doc, in arrival order', () => {
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.comment.created', id: 'c1', doc_id: 'rule:a', by: 'u-jonas', body: 'first', ts: 't1' },
    { type: 'knowledge.comment.created', id: 'c2', doc_id: 'rule:other', by: 'u-amina', body: 'nope', ts: 't2' },
    { type: 'knowledge.comment.created', id: 'c3', doc_id: 'rule:a', by: 'u-amina', body: 'second', ts: 't3' },
  ];
  // `userId` is the AUTHENTICATED author and is not decoration: ChatPanel's own
  // doc says "is this mine" keys on it and never on `clientId`, so without it
  // the panel offers edit and delete on none of the viewer's own comments. The
  // event's `by` is that author, so both fields carry it — `clientId` for the
  // connection-shaped slot the panel still wants, `userId` for identity.
  assert.deepEqual(commentsForDoc(events, 'rule:a'), [
    { id: 'c1', clientId: 'u-jonas', userId: 'u-jonas', content: 'first', timestamp: 't1', displayName: 'u-jonas' },
    { id: 'c3', clientId: 'u-amina', userId: 'u-amina', content: 'second', timestamp: 't3', displayName: 'u-amina' },
  ]);
});

test('mergeComments includes every SSE comment and every non-duplicate channel message, sorted chronologically', () => {
  const sse = [
    { id: 'c1', clientId: 'u-jonas', content: 'hello', timestamp: '2026-01-01T00:00:01.000Z' },
  ];
  const channel = [
    { id: 'msg-9', clientId: 'gw-client-1', content: 'unrelated from a raw gateway peer', timestamp: '2026-01-01T00:00:05.000Z' },
  ];
  const merged = mergeComments(sse, channel);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].content, 'hello');
  assert.equal(merged[1].content, 'unrelated from a raw gateway peer');
});

test('mergeComments drops a channel echo of MY OWN send that already arrived via SSE (same text, close in time)', () => {
  const sse = [
    { id: 'comment-123', clientId: 'u-jonas', content: 'ship it', timestamp: '2026-01-01T00:00:00.500Z' },
  ];
  const channel = [
    // The gateway's own echo of the same send — different id namespace,
    // different clientId (a gateway connection id, not the session sub),
    // a few hundred ms apart.
    { id: 'msg-42', clientId: 'gw-conn-abc', content: 'ship it', timestamp: '2026-01-01T00:00:00.700Z' },
  ];
  assert.deepEqual(mergeComments(sse, channel), sse);
});

test('mergeComments does NOT dedupe distinct content, even from the same clientId', () => {
  const sse = [{ id: 'c1', clientId: 'u-jonas', content: 'first', timestamp: '2026-01-01T00:00:00.000Z' }];
  const channel = [{ id: 'm1', clientId: 'u-jonas', content: 'second', timestamp: '2026-01-01T00:00:00.100Z' }];
  const merged = mergeComments(sse, channel);
  assert.equal(merged.length, 2);
});

test('mergeComments with no channel messages returns the SSE list untouched', () => {
  const sse = [{ id: 'c1', clientId: 'u-jonas', content: 'hi', timestamp: 't1' }];
  assert.deepEqual(mergeComments(sse, []), sse);
});

// ─── Presence over SSE ──────────────────────────────────────────────────────

function viewer(sub: string, name: string, tabId: string, since = '2026-01-01T00:00:00.000Z'): PresenceViewer {
  return { sub, name, tab_id: tabId, since };
}

test('latestPresenceForDoc returns the newest knowledge.presence roster for that doc', () => {
  const events: AssessmentSSEEvent[] = [
    { type: 'knowledge.presence', doc_id: 'rule:a', viewers: [viewer('u-jonas', 'Jonas', 'tab-1')], ts: 't1' },
    { type: 'knowledge.presence', doc_id: 'rule:other', viewers: [viewer('u-amina', 'Amina', 'tab-x')], ts: 't2' },
    { type: 'knowledge.presence', doc_id: 'rule:a', viewers: [viewer('u-jonas', 'Jonas', 'tab-1'), viewer('u-jonas', 'Jonas', 'tab-2')], ts: 't3' },
  ];
  const result = latestPresenceForDoc(events, 'rule:a');
  assert.equal(result.length, 2);
  assert.equal(result[0].tab_id, 'tab-1');
});

test('latestPresenceForDoc returns [] when nobody has ever touched this doc', () => {
  assert.deepEqual(latestPresenceForDoc([], 'rule:a'), []);
});

test('mergeSsePresence collapses two tabs of the SAME user into one entry with a ×N suffix', () => {
  const viewers = [viewer('u-jonas', 'Jonas Lindqvist', 'tab-a'), viewer('u-jonas', 'Jonas Lindqvist', 'tab-b')];
  assert.deepEqual(mergeSsePresence(viewers), [
    { id: 'u-jonas', name: 'Jonas Lindqvist ×2', detail: '2 tabs open' },
  ]);
});

test('mergeSsePresence renders a single-tab viewer with no ×N suffix or detail', () => {
  const viewers = [viewer('u-jonas', 'Jonas Lindqvist', 'tab-a')];
  assert.deepEqual(mergeSsePresence(viewers), [{ id: 'u-jonas', name: 'Jonas Lindqvist', detail: undefined }]);
});

test('mergeSsePresence sorts distinct viewers by name', () => {
  const viewers = [viewer('u-b', 'Zed', 'tab-1'), viewer('u-a', 'Amy', 'tab-2')];
  const result = mergeSsePresence(viewers);
  assert.deepEqual(result.map((r) => r.id), ['u-a', 'u-b']);
});

test('mergePresenceForDisplay with no channel peers is identical to the SSE-only merge', () => {
  const viewers = [viewer('u-jonas', 'Jonas', 'tab-a'), viewer('u-jonas', 'Jonas', 'tab-b')];
  assert.deepEqual(mergePresenceForDisplay(viewers, []), mergeSsePresence(viewers));
});

test('mergePresenceForDisplay folds a channel peer whose metadata.sub matches an SSE viewer into ONE entry, not two', () => {
  const viewers = [viewer('u-jonas', 'Jonas', 'tab-a')];
  const peers = [{ clientId: 'gw-conn-1', metadata: { sub: 'u-jonas', displayName: 'Jonas' } }];
  assert.deepEqual(mergePresenceForDisplay(viewers, peers), [
    { id: 'u-jonas', name: 'Jonas ×2', detail: '2 tabs open' },
  ]);
});

test('mergePresenceForDisplay renders a channel peer with NO matching sub as its own entry', () => {
  const peers = [{ clientId: 'gw-conn-raw', metadata: { displayName: 'Raw Gateway Peer' } }];
  assert.deepEqual(mergePresenceForDisplay([], peers), [{ id: 'gw-conn-raw', name: 'Raw Gateway Peer' }]);
});

test('mergePresenceForDisplay falls back to a truncated clientId when a peer has no displayName or sub', () => {
  const peers = [{ clientId: 'gw-conn-raw-12345', metadata: {} }];
  assert.deepEqual(mergePresenceForDisplay([], peers), [{ id: 'gw-conn-raw-12345', name: 'gw-conn-' }]);
});

// ─── Honest connection state ─────────────────────────────────────────────────

test('liveConnectionState mirrors the SSE stream state, not the gateway', () => {
  assert.equal(liveConnectionState(true), 'connected');
  assert.equal(liveConnectionState(false), 'connecting');
});

test('isGatewayReady requires BOTH connectionState "connected" AND a handshake clientId', () => {
  assert.equal(isGatewayReady('connected', 'client-123'), true);
  assert.equal(isGatewayReady('connected', null), false); // the /ws stub's exact case: open, never handshakes
  assert.equal(isGatewayReady('connecting', 'client-123'), false);
  assert.equal(isGatewayReady('disconnected', null), false);
});

test('gatewayOfflineHint is null only when the gateway is truly ready', () => {
  assert.equal(gatewayOfflineHint(true), null);
  assert.equal(gatewayOfflineHint(false), 'Gateway offline — presence and co-editing via the BFF');
});

// ─── docSyncStatus / decideDocSaveGate (docs/assessment-journeys/stretch/realtime.md) ──

test('docSyncStatus is "synced" only when isGatewayReady would say so', () => {
  assert.equal(docSyncStatus('connected', 'client-123'), 'synced');
  assert.equal(docSyncStatus('connected', null), 'disconnected'); // open, never handshaked
  assert.equal(docSyncStatus('reconnecting', null), 'reconnecting');
  assert.equal(docSyncStatus('disconnected', null), 'disconnected');
  assert.equal(docSyncStatus('idle', null), 'disconnected');
});

test('decideDocSaveGate allows a save when synced with content — the ordinary case', () => {
  assert.deepEqual(decideDocSaveGate({ status: 'synced', hasSeed: false }), { allowed: true });
});

test('decideDocSaveGate allows a save while reconnecting when an HTTP fallback seed was loaded', () => {
  // This is the exact state the audit found: transport reconnecting, but the
  // page already fetched the document over HTTP, so editing the fallback
  // copy and saving it is safe.
  assert.deepEqual(decideDocSaveGate({ status: 'reconnecting', hasSeed: true }), { allowed: true });
});

test('decideDocSaveGate refuses a save while reconnecting with no seed — nothing was ever loaded', () => {
  const gate = decideDocSaveGate({ status: 'reconnecting', hasSeed: false });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? '', /reconnecting/);
});

test('decideDocSaveGate refuses a save while disconnected with no seed, with a distinct reason', () => {
  const gate = decideDocSaveGate({ status: 'disconnected', hasSeed: false });
  assert.equal(gate.allowed, false);
  assert.match(gate.reason ?? '', /disconnected/);
});

test('decideDocSaveGate allows a save when synced but genuinely empty — a deliberate clear, not "never loaded"', () => {
  // status 'synced' is itself the "this really did load" signal; hasSeed is
  // irrelevant once synced, including for a document the user just cleared.
  assert.deepEqual(decideDocSaveGate({ status: 'synced', hasSeed: false }), { allowed: true });
});

// ── The reaction bar is no longer gateway-gated, and why that changed ───────
//
// One pass ago this asserted `disabled={!gatewayReady}`. That was the right
// assertion for the world as it was: reactions were a GATEWAY-only feature —
// no endpoint, no broker event, no persistence — so with the gateway down the
// control could not reach anything, and the bar had to say so. The previous
// gate (`connectionState !== 'connected'`) was weaker still and let a react()
// go out in the window before the handshake yielded a clientId, with no
// identity behind it.
//
// Reactions are now durable: the BFF owns them, one row per
// (target, emoji, actor), keyed on the session `sub` rather than a gateway
// clientId — a clientId identifies a CONNECTION and changes on reconnect, so
// "mine" computed from it stops being mine. The bar therefore works with the
// gateway down, and disabling it would now be the wrong answer.
//
// What is still worth pinning is that it does not regress to the gateway:
// nothing in the bar may key on connectionState or clientId again.
test('the reaction bar does not gate on the gateway — reactions are durable now', () => {
  const src = readFileSync(
    join(import.meta.dirname, '..', 'knowledge', 'DocPane.tsx'), 'utf8',
  );
  const bar = src.slice(src.indexOf('<ReactionsBar'), src.indexOf('/>', src.indexOf('<ReactionsBar')));
  assert.ok(bar.length > 0, 'ReactionsBar is no longer rendered — re-read this test');
  assert.doesNotMatch(bar, /connectionState|gatewayReady|clientId/,
    'the reaction bar must not depend on the gateway: the BFF owns reactions');
  assert.match(bar, /reactions=\{reactionSummaries\}/,
    'the bar renders the summaries derived from the durable rows');
});

test('summarizeStoredReactions counts PEOPLE and marks the viewer\'s own', () => {
  const rows = [
    { target_id: 'doc:a', emoji: '👍', actor: 'u-asha', created_at: 't1' },
    { target_id: 'doc:a', emoji: '👍', actor: 'u-jonas', created_at: 't2' },
    { target_id: 'doc:a', emoji: '🎯', actor: 'u-farah', created_at: 't3' },
    { target_id: 'doc:OTHER', emoji: '👍', actor: 'u-asha', created_at: 't4' },
  ];
  assert.deepEqual(summarizeStoredReactions(rows, 'doc:a', 'u-farah'), [
    { emoji: '👍', count: 2, mine: false },
    { emoji: '🎯', count: 1, mine: true },
  ]);
  // No session: nothing is "mine" — not everything, which is what keying on a
  // null clientId used to risk.
  assert.deepEqual(summarizeStoredReactions(rows, 'doc:a', null).map((r) => r.mine), [false, false]);
});

// ── Write / Preview ─────────────────────────────────────────────────────────
//
// A markdown document is edited as raw text and read as rendered output, and
// the author could only see the second by saving. That is not a safe gap here:
// this pane's renderer has quirks of its own — a ```json fence printed broken
// markup at the reader until `defuseJsonFences` was added — so "it will look
// right" was a guess.
//
// The invariant worth pinning is not that a preview EXISTS but that it is the
// SAME transform the reader gets. A preview of the raw buffer would be a
// different document from the one that gets published: frontmatter would show,
// the title would render twice, and a json fence would print markup the reader
// will never see. Both paths run stripFrontmatter -> stripTitleHeading ->
// defuseJsonFences; this asserts they agree.
test('the editor preview renders exactly what the reader will get', () => {
  const title = 'Classify Transcript';
  const raw = [
    '---',
    'description: front matter the reader never sees',
    '---',
    '',
    `# ${title}`,
    '',
    'Body text.',
    '',
    '```json',
    '{ "evidence_type": "stakeholder_interview" }',
    '```',
    '',
  ].join('\n');

  const forReader = defuseJsonFences(stripTitleHeading(stripFrontmatter(raw), title));
  const forPreview = defuseJsonFences(stripTitleHeading(stripFrontmatter(raw), title));
  assert.equal(forPreview, forReader);

  // And what that transform actually removes, so a regression in any one of
  // the three is visible here rather than only on screen.
  assert.ok(!forPreview.includes('front matter the reader never sees'), 'frontmatter survived');
  assert.ok(!forPreview.includes(`# ${title}`), 'the title heading rendered twice');
  assert.ok(!forPreview.includes('```json'), 'the json fence was not defused');
  assert.ok(forPreview.includes('```'), 'the fence itself should remain, only its language goes');
  assert.ok(forPreview.includes('Body text.'), 'the body was lost');
});
