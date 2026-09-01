// Newsroom Articles provider — reads article + entity data from Aurora PostgreSQL
// via RDS Data API. Tables: documents (extended with newsroom columns), entities,
// article_entities, sources, story_clusters, people.
// Does NOT import from or modify types.ts or aurora.ts — all types and exec are local.
// Queries wrapped in try/catch; returns empty defaults when tables/columns don't exist.

import {
  RDSDataClient,
  ExecuteStatementCommand,
  type SqlParameter,
  type Field,
} from '@aws-sdk/client-rds-data';

import { config } from '../config.js';
import {
  mockArticles, mockEntities, mockClusters, mockPitches,
  mockUpdatePitchStatus, mockPublishArticle,
  type MockArticle,
} from '../mock/newsroom.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ArticleSummary {
  id: string;
  headline: string | null;
  section: string | null;
  status: string | null;
  publishedAt: string | null;
  byline: { id: string; name: string } | null;
  wordCount: number | null;
  entityCount: number;
}

export interface ArticleDetail extends ArticleSummary {
  subheadline: string | null;
  body: string | null;
  entities: Array<{
    id: string;
    name: string;
    entityType: string;
    salience: number;
    role: string | null;
  }>;
  sources: Array<{
    id: string;
    entityName: string | null;
    sourceType: string;
    attribution: string | null;
    quoteSnippet: string | null;
  }>;
  cluster: { id: string; title: string } | null;
}

export interface EntityDetail {
  id: string;
  name: string;
  entityType: string;
  aliases: string[];
  appearances: Array<{
    articleId: string;
    headline: string | null;
    publishedAt: string | null;
    salience: number;
  }>;
  coMentions: Array<{
    entityId: string;
    entityName: string;
    entityType: string;
    sharedArticleCount: number;
  }>;
}

export interface TodayStats {
  total: number;
  sections: Array<{ name: string; count: number }>;
}

// ─── RDS Data API helpers (local to this module) ─────────────────────────────

let _client: RDSDataClient | null = null;
function getClient(): RDSDataClient {
  if (!_client) _client = new RDSDataClient({ region: config.region });
  return _client;
}

function readField(cell: Field | undefined): unknown {
  if (!cell) return null;
  if (cell.isNull) return null;
  if (cell.stringValue !== undefined) return cell.stringValue;
  if (cell.longValue !== undefined) return cell.longValue;
  if (cell.doubleValue !== undefined) return cell.doubleValue;
  if (cell.booleanValue !== undefined) return cell.booleanValue;
  return null;
}

async function exec(
  sql: string,
  params: SqlParameter[] = [],
): Promise<Record<string, unknown>[]> {
  const resp = await getClient().send(
    new ExecuteStatementCommand({
      resourceArn: config.aurora.clusterArn,
      secretArn: config.aurora.secretArn,
      database: config.aurora.database,
      sql,
      parameters: params,
      includeResultMetadata: true,
    }),
  );
  const cols = (resp.columnMetadata ?? []).map((c) => c.name ?? '');
  return (resp.records ?? []).map((record) => {
    const row: Record<string, unknown> = {};
    record.forEach((cell, i) => {
      row[cols[i] ?? `col${i}`] = readField(cell);
    });
    return row;
  });
}

function strParam(name: string, value: string): SqlParameter {
  return { name, value: { stringValue: value } };
}

function intParam(name: string, value: number): SqlParameter {
  return { name, value: { longValue: value } };
}

function str(v: unknown): string {
  return String(v ?? '');
}

function strOrNull(v: unknown): string | null {
  return v != null ? String(v) : null;
}

function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// ─── Provider functions ───────────────────────────────────────────────────────

function mockToSummary(a: MockArticle): ArticleSummary {
  return {
    id: a.id,
    headline: a.headline,
    section: a.section,
    status: a.status,
    publishedAt: a.publishedAt,
    byline: a.byline,
    wordCount: a.wordCount,
    entityCount: a.entityIds.length,
  };
}

export async function listArticles(opts: {
  beat?: string;
  since?: string;
  limit?: number;
}): Promise<ArticleSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);

  if (config.mock.aurora) {
    let rows = mockArticles.slice();
    if (opts.beat) rows = rows.filter((a) => a.section === opts.beat);
    if (opts.since) {
      const sinceMs = Date.parse(opts.since);
      rows = rows.filter((a) => a.publishedAt != null && Date.parse(a.publishedAt) >= sinceMs);
    }
    rows.sort((a, b) => {
      if (a.publishedAt == null) return 1;
      if (b.publishedAt == null) return -1;
      return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
    });
    return rows.slice(0, limit).map(mockToSummary);
  }

  const params: SqlParameter[] = [intParam('lim', limit)];
  const whereClauses: string[] = ["d.doc_type = 'news_article'"];

  if (opts.beat) {
    params.push(strParam('beat', opts.beat));
    whereClauses.push('d.section = :beat');
  }
  if (opts.since) {
    params.push(strParam('since', opts.since));
    whereClauses.push('d.published_at >= :since::timestamptz');
  }

  const where = `WHERE ${whereClauses.join(' AND ')}`;

  const sql = `
    SELECT
      d.id,
      d.headline,
      d.section,
      d.status,
      d.published_at,
      d.word_count,
      p.id   AS byline_id,
      p.name AS byline_name,
      COUNT(ae.entity_id) AS entity_count
    FROM documents d
    LEFT JOIN people p ON p.id = d.byline_person_id
    LEFT JOIN article_entities ae ON ae.article_id = d.id
    ${where}
    GROUP BY d.id, d.headline, d.section, d.status, d.published_at,
             d.word_count, p.id, p.name
    ORDER BY d.published_at DESC NULLS LAST
    LIMIT :lim
  `;

  try {
    const rows = await exec(sql, params);
    return rows.map((r) => ({
      id: str(r['id']),
      headline: strOrNull(r['headline']),
      section: strOrNull(r['section']),
      status: strOrNull(r['status']),
      publishedAt: strOrNull(r['published_at']),
      byline:
        r['byline_id'] != null
          ? { id: str(r['byline_id']), name: str(r['byline_name']) }
          : null,
      wordCount: numOrNull(r['word_count']),
      entityCount: Number(r['entity_count'] ?? 0),
    }));
  } catch {
    return [];
  }
}

export async function getArticle(id: string): Promise<ArticleDetail | null> {
  if (config.mock.aurora) {
    const a = mockArticles.find((x) => x.id === id);
    if (!a) return null;
    const cluster = mockClusters.find((c) => c.id === a.clusterId) ?? null;
    return {
      ...mockToSummary(a),
      subheadline: a.subheadline,
      body: a.body,
      entities: a.entityIds.map((e) => {
        const ent = mockEntities.find((m) => m.id === e.id);
        return {
          id: e.id,
          name: ent?.name ?? e.id,
          entityType: ent?.entityType ?? 'unknown',
          salience: e.salience,
          role: e.role,
        };
      }),
      sources: [],
      cluster: cluster ? { id: cluster.id, title: cluster.title } : null,
    };
  }
  try {
    const articleRows = await exec(
      `SELECT
         d.id, d.headline, d.subheadline, d.section, d.status,
         d.published_at, d.word_count, d.title,
         p.id   AS byline_id,
         p.name AS byline_name
       FROM documents d
       LEFT JOIN people p ON p.id = d.byline_person_id
       WHERE d.id = :id AND d.doc_type = 'news_article'
       LIMIT 1`,
      [strParam('id', id)],
    );

    if (articleRows.length === 0) return null;
    const a = articleRows[0]!;

    // Entity count for summary fields
    let entityCountRow: Record<string, unknown>[] = [];
    try {
      entityCountRow = await exec(
        `SELECT COUNT(*) AS cnt FROM article_entities WHERE article_id = :id`,
        [strParam('id', id)],
      );
    } catch {
      // table may not exist yet
    }

    const entityCount = Number(entityCountRow[0]?.['cnt'] ?? 0);

    // Entities
    let entityRows: Record<string, unknown>[] = [];
    try {
      entityRows = await exec(
        `SELECT
           e.id, e.name, e.entity_type,
           ae.salience, ae.role
         FROM article_entities ae
         JOIN entities e ON e.id = ae.entity_id
         WHERE ae.article_id = :id
         ORDER BY ae.salience DESC`,
        [strParam('id', id)],
      );
    } catch {
      // table may not exist yet
    }

    // Sources
    let sourceRows: Record<string, unknown>[] = [];
    try {
      sourceRows = await exec(
        `SELECT s.id, s.source_type, s.attribution, s.quote_snippet, s.entity_id, e.name AS entity_name
         FROM sources s
         LEFT JOIN entities e ON e.id = s.entity_id
         WHERE s.article_id = :id
         ORDER BY s.created_at ASC`,
        [strParam('id', id)],
      );
    } catch {
      // table may not exist yet
    }

    // Cluster
    let clusterRow: Record<string, unknown> | null = null;
    try {
      const clusterRows = await exec(
        `SELECT sc.id, sc.title
         FROM story_clusters sc
         JOIN cluster_articles ca ON ca.cluster_id = sc.id
         WHERE ca.article_id = :id
         LIMIT 1`,
        [strParam('id', id)],
      );
      clusterRow = clusterRows[0] ?? null;
    } catch {
      // table/join may not exist yet
    }

    return {
      id: str(a['id']),
      headline: strOrNull(a['headline']),
      subheadline: strOrNull(a['subheadline']),
      section: strOrNull(a['section']),
      status: strOrNull(a['status']),
      publishedAt: strOrNull(a['published_at']),
      byline:
        a['byline_id'] != null
          ? { id: str(a['byline_id']), name: str(a['byline_name']) }
          : null,
      wordCount: numOrNull(a['word_count']),
      entityCount,
      body: strOrNull(a['title']), // use title as body placeholder until content column exists
      entities: entityRows.map((e) => ({
        id: str(e['id']),
        name: str(e['name']),
        entityType: str(e['entity_type']),
        salience: Number(e['salience'] ?? 0),
        role: strOrNull(e['role']),
      })),
      sources: sourceRows.map((s) => ({
        id: str(s['id']),
        entityName: strOrNull(s['entity_name']),
        sourceType: str(s['source_type']),
        attribution: strOrNull(s['attribution']),
        quoteSnippet: strOrNull(s['quote_snippet']),
      })),
      cluster:
        clusterRow != null
          ? { id: str(clusterRow['id']), title: str(clusterRow['title']) }
          : null,
    };
  } catch {
    return null;
  }
}

export async function getTodayStats(): Promise<TodayStats> {
  if (config.mock.aurora) {
    const today = new Date().toISOString().slice(0, 10);
    const todays = mockArticles.filter(
      (a) => a.status === 'published' && a.publishedAt != null && a.publishedAt.slice(0, 10) === today,
    );
    const bySection = new Map<string, number>();
    for (const a of todays) bySection.set(a.section, (bySection.get(a.section) ?? 0) + 1);
    return {
      total: todays.length,
      sections: Array.from(bySection.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    };
  }
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const params = [strParam('today', today)];

    const totalRows = await exec(
      `SELECT COUNT(*) AS cnt
       FROM documents
       WHERE doc_type = 'news_article'
         AND published_at::date = :today::date`,
      params,
    );
    const total = Number(totalRows[0]?.['cnt'] ?? 0);

    const sectionRows = await exec(
      `SELECT section, COUNT(*) AS cnt
       FROM documents
       WHERE doc_type = 'news_article'
         AND published_at::date = :today::date
         AND section IS NOT NULL
       GROUP BY section
       ORDER BY cnt DESC`,
      params,
    );

    return {
      total,
      sections: sectionRows.map((r) => ({
        name: str(r['section']),
        count: Number(r['cnt'] ?? 0),
      })),
    };
  } catch {
    return { total: 0, sections: [] };
  }
}

export async function getEntity(id: string): Promise<EntityDetail | null> {
  if (config.mock.aurora) {
    const e = mockEntities.find((x) => x.id === id);
    if (!e) return null;
    const appearances = mockArticles
      .filter((a) => a.entityIds.some((m) => m.id === id))
      .map((a) => ({
        articleId: a.id,
        headline: a.headline,
        publishedAt: a.publishedAt,
        salience: a.entityIds.find((m) => m.id === id)?.salience ?? 0,
      }));
    const sharedArticleIds = new Set(appearances.map((a) => a.articleId));
    const coMentionCounts = new Map<string, number>();
    for (const a of mockArticles) {
      if (!sharedArticleIds.has(a.id)) continue;
      for (const m of a.entityIds) {
        if (m.id === id) continue;
        coMentionCounts.set(m.id, (coMentionCounts.get(m.id) ?? 0) + 1);
      }
    }
    const coMentions = Array.from(coMentionCounts.entries())
      .map(([entId, count]) => {
        const ent = mockEntities.find((x) => x.id === entId);
        return {
          entityId: entId,
          entityName: ent?.name ?? entId,
          entityType: ent?.entityType ?? 'unknown',
          sharedArticleCount: count,
        };
      })
      .sort((a, b) => b.sharedArticleCount - a.sharedArticleCount);
    return { id: e.id, name: e.name, entityType: e.entityType, aliases: e.aliases, appearances, coMentions };
  }
  try {
    const entityRows = await exec(
      `SELECT id, name, entity_type, aliases FROM entities WHERE id = :id LIMIT 1`,
      [strParam('id', id)],
    );
    if (entityRows.length === 0) return null;
    const e = entityRows[0]!;

    // Parse aliases — stored as JSON array or comma-separated string
    let aliases: string[] = [];
    const rawAliases = e['aliases'];
    if (rawAliases != null) {
      try {
        const parsed: unknown = typeof rawAliases === 'string' ? JSON.parse(rawAliases) : rawAliases;
        if (Array.isArray(parsed)) {
          aliases = parsed.map(String);
        }
      } catch {
        // not valid JSON — treat as single string
        aliases = [String(rawAliases)];
      }
    }

    // Appearances
    let appearanceRows: Record<string, unknown>[] = [];
    try {
      appearanceRows = await exec(
        `SELECT
           d.id AS article_id,
           d.headline,
           d.published_at,
           ae.salience
         FROM article_entities ae
         JOIN documents d ON d.id = ae.article_id
         WHERE ae.entity_id = :id
           AND d.doc_type = 'news_article'
         ORDER BY d.published_at DESC NULLS LAST
         LIMIT 50`,
        [strParam('id', id)],
      );
    } catch {
      // table may not exist yet
    }

    // Co-mentions: other entities appearing in the same articles
    let coMentionRows: Record<string, unknown>[] = [];
    try {
      coMentionRows = await exec(
        `SELECT
           e2.id   AS entity_id,
           e2.name AS entity_name,
           e2.entity_type,
           COUNT(DISTINCT ae2.article_id) AS shared_article_count
         FROM article_entities ae1
         JOIN article_entities ae2
           ON ae2.article_id = ae1.article_id
           AND ae2.entity_id != ae1.entity_id
         JOIN entities e2 ON e2.id = ae2.entity_id
         WHERE ae1.entity_id = :id
         GROUP BY e2.id, e2.name, e2.entity_type
         ORDER BY shared_article_count DESC
         LIMIT 20`,
        [strParam('id', id)],
      );
    } catch {
      // table may not exist yet
    }

    return {
      id: str(e['id']),
      name: str(e['name']),
      entityType: str(e['entity_type']),
      aliases,
      appearances: appearanceRows.map((r) => ({
        articleId: str(r['article_id']),
        headline: strOrNull(r['headline']),
        publishedAt: strOrNull(r['published_at']),
        salience: Number(r['salience'] ?? 0),
      })),
      coMentions: coMentionRows.map((r) => ({
        entityId: str(r['entity_id']),
        entityName: str(r['entity_name']),
        entityType: str(r['entity_type']),
        sharedArticleCount: Number(r['shared_article_count'] ?? 0),
      })),
    };
  } catch {
    return null;
  }
}

// ─── Clusters + pitches (Newsroom home) ───────────────────────────────────────
// Shapes match portal/src/pages/newsroom/HomePage.tsx (ClustersResponse /
// PitchesResponse). "active" = updated in the last 14 days.

export interface ClustersSummary {
  total: number;
  active: Array<{ id: string; headline: string; size: number }>;
}

export interface PitchesSummary {
  total: number;
  open: Array<{ id: string; headline: string; createdAt: string }>;
}

export async function getClusters(): Promise<ClustersSummary> {
  if (config.mock.aurora) {
    const fourteenDaysAgoMs = Date.now() - 14 * 86_400_000;
    const active = mockClusters
      .filter((c) => Date.parse(c.lastUpdated) > fourteenDaysAgoMs)
      .map((c) => ({
        id: c.id,
        headline: c.title,
        size: mockArticles.filter((a) => a.clusterId === c.id).length,
      }))
      .sort((a, b) => b.size - a.size);
    return { total: mockClusters.length, active };
  }
  const totalRows = await exec('SELECT count(*)::int AS n FROM story_clusters');
  const rows = await exec(`
    SELECT sc.id, sc.title, count(ca.article_id)::int AS size
    FROM story_clusters sc
    LEFT JOIN cluster_articles ca ON ca.cluster_id = sc.id
    WHERE sc.last_updated > NOW() - INTERVAL '14 days'
    GROUP BY sc.id, sc.title
    ORDER BY size DESC, sc.last_updated DESC
    LIMIT 20
  `);
  return {
    total: Number(totalRows[0]?.['n'] ?? 0),
    active: rows.map((r) => ({
      id: String(r['id']),
      headline: String(r['title'] ?? ''),
      size: Number(r['size'] ?? 0),
    })),
  };
}

export async function getPitches(status = 'open'): Promise<PitchesSummary> {
  if (config.mock.aurora) {
    const all = mockPitches();
    const filtered = all
      .filter((p) => p.status === status)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return {
      total: all.length,
      open: filtered.map((p) => ({ id: p.id, headline: p.title, createdAt: p.createdAt })),
    };
  }
  const totalRows = await exec('SELECT count(*)::int AS n FROM pitches');
  const rows = await exec(
    'SELECT id, title, created_at FROM pitches WHERE status = :status ORDER BY created_at DESC LIMIT 20',
    [{ name: 'status', value: { stringValue: status } }],
  );
  return {
    total: Number(totalRows[0]?.['n'] ?? 0),
    open: rows.map((r) => ({
      id: String(r['id']),
      headline: String(r['title'] ?? ''),
      createdAt: String(r['created_at'] ?? ''),
    })),
  };
}

// ─── Pitch board (full desk view, /newsroom/pitches) ─────────────────────────
// The home card shows a one-status summary; the board is the whole backlog:
// every pitch with its beat, proposer, assignee and cluster, plus counts per
// status so the page can filter without refetching.

export interface PitchBoardItem {
  id: string;
  title: string;
  body: string | null;
  beat: string | null;
  status: string;
  proposedBy: { id: string; name: string } | null;
  assignedTo: { id: string; name: string } | null;
  cluster: { id: string; title: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface PitchBoard {
  counts: Record<string, number>;
  pitches: PitchBoardItem[];
}

export async function getPitchBoard(): Promise<PitchBoard> {
  if (config.mock.aurora) {
    const all = mockPitches();
    const counts: Record<string, number> = {};
    for (const p of all) counts[p.status] = (counts[p.status] ?? 0) + 1;
    const byId = new Map(mockClusters.map((c) => [c.id, c]));
    return {
      counts,
      pitches: all
        .slice()
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
        .map((p) => ({
          id: p.id,
          title: p.title,
          body: p.body,
          beat: p.beat,
          status: p.status,
          proposedBy: p.proposedBy,
          assignedTo: p.assignedTo,
          cluster: p.clusterId && byId.has(p.clusterId)
            ? { id: p.clusterId, title: byId.get(p.clusterId)!.title }
            : null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
    };
  }
  const countRows = await exec('SELECT status, count(*)::int AS n FROM pitches GROUP BY status');
  const rows = await exec(`
    SELECT p.id, p.title, p.body, p.beat, p.status, p.created_at, p.updated_at,
           pp.id AS proposer_id, pp.name AS proposer_name,
           ap.id AS assignee_id, ap.name AS assignee_name,
           sc.id AS cluster_id, sc.title AS cluster_title
    FROM pitches p
    LEFT JOIN people pp ON pp.id = p.proposed_by
    LEFT JOIN people ap ON ap.id = p.assigned_to
    LEFT JOIN story_clusters sc ON sc.id = p.cluster_id
    ORDER BY p.updated_at DESC
    LIMIT 200
  `);
  const counts: Record<string, number> = {};
  for (const r of countRows) counts[String(r['status'])] = Number(r['n'] ?? 0);
  return {
    counts,
    pitches: rows.map((r) => ({
      id: String(r['id']),
      title: String(r['title'] ?? ''),
      body: r['body'] ? String(r['body']) : null,
      beat: r['beat'] ? String(r['beat']) : null,
      status: String(r['status'] ?? 'open'),
      proposedBy: r['proposer_id']
        ? { id: String(r['proposer_id']), name: String(r['proposer_name'] ?? '') }
        : null,
      assignedTo: r['assignee_id']
        ? { id: String(r['assignee_id']), name: String(r['assignee_name'] ?? '') }
        : null,
      cluster: r['cluster_id']
        ? { id: String(r['cluster_id']), title: String(r['cluster_title'] ?? '') }
        : null,
      createdAt: String(r['created_at'] ?? ''),
      updatedAt: String(r['updated_at'] ?? ''),
    })),
  };
}

// ─── Mutations (Cedar-gated in the router) ───────────────────────────────────

export const PITCH_STATUSES = ['open', 'assigned', 'approved', 'killed', 'filed'] as const;

export async function updatePitchStatus(id: string, status: string): Promise<boolean> {
  if (config.mock.aurora) return mockUpdatePitchStatus(id, status);
  const rows = await exec(
    'UPDATE pitches SET status = :status, updated_at = NOW() WHERE id = :id RETURNING id',
    [strParam('status', status), strParam('id', id)],
  );
  return rows.length > 0;
}

export async function publishArticle(id: string): Promise<boolean> {
  if (config.mock.aurora) return mockPublishArticle(id);
  const rows = await exec(
    "UPDATE documents SET status = 'published', published_at = COALESCE(published_at, NOW()) " +
    "WHERE id = :id AND doc_type = 'news_article' RETURNING id",
    [strParam('id', id)],
  );
  return rows.length > 0;
}
