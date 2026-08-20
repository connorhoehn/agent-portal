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

export async function listArticles(opts: {
  beat?: string;
  since?: string;
  limit?: number;
}): Promise<ArticleSummary[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: SqlParameter[] = [intParam('lim', limit)];
  const whereClauses: string[] = ["d.doc_type = 'article'"];

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
  try {
    const articleRows = await exec(
      `SELECT
         d.id, d.headline, d.subheadline, d.section, d.status,
         d.published_at, d.word_count, d.title,
         p.id   AS byline_id,
         p.name AS byline_name
       FROM documents d
       LEFT JOIN people p ON p.id = d.byline_person_id
       WHERE d.id = :id AND d.doc_type = 'article'
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
  try {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const params = [strParam('today', today)];

    const totalRows = await exec(
      `SELECT COUNT(*) AS cnt
       FROM documents
       WHERE doc_type = 'article'
         AND published_at::date = :today::date`,
      params,
    );
    const total = Number(totalRows[0]?.['cnt'] ?? 0);

    const sectionRows = await exec(
      `SELECT section, COUNT(*) AS cnt
       FROM documents
       WHERE doc_type = 'article'
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
           AND d.doc_type = 'article'
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

// ─── Mutations (Cedar-gated in the router) ───────────────────────────────────

export const PITCH_STATUSES = ['open', 'assigned', 'approved', 'killed', 'filed'] as const;

export async function updatePitchStatus(id: string, status: string): Promise<boolean> {
  const rows = await exec(
    'UPDATE pitches SET status = :status, updated_at = NOW() WHERE id = :id RETURNING id',
    [strParam('status', status), strParam('id', id)],
  );
  return rows.length > 0;
}

export async function publishArticle(id: string): Promise<boolean> {
  const rows = await exec(
    "UPDATE documents SET status = 'published', published_at = COALESCE(published_at, NOW()) " +
    "WHERE id = :id AND doc_type = 'article' RETURNING id",
    [strParam('id', id)],
  );
  return rows.length > 0;
}
